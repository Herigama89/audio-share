// Audio Share - Mac app-audio capture helper.
// Uses Core Audio process taps (macOS 14.2+) to copy the sound of one app
// (your DAW) without any virtual audio driver. The app keeps playing normally.
//
//   daw-capture list               -> JSON list of apps that use audio (stdout)
//   daw-capture capture <pid>...   -> raw 32-bit float stereo PCM on stdout,
//                                     "FORMAT {...}" line on stderr once started
import Foundation
import CoreAudio
import AudioToolbox
import AppKit

func errLine(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}
func outJSON(_ obj: Any) {
    if let d = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardOutput.write(d)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

func addr(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel,
                               mScope: kAudioObjectPropertyScopeGlobal,
                               mElement: kAudioObjectPropertyElementMain)
}

func readScalar<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T) -> T? {
    var a = addr(sel)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let st = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0)
    }
    return st == noErr ? value : nil
}

func readString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = addr(sel)
    var ref: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = withUnsafeMutablePointer(to: &ref) {
        AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0)
    }
    guard st == noErr, let r = ref else { return nil }
    return r.takeRetainedValue() as String
}

func readIDList(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> [AudioObjectID] {
    var a = addr(sel)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    let st = list.withUnsafeMutableBufferPointer {
        AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0.baseAddress!)
    }
    return st == noErr ? list : []
}

struct AudioProc {
    let objectID: AudioObjectID
    let pid: pid_t
    let bundleID: String
    let playing: Bool
}

@available(macOS 14.2, *)
func audioProcesses() -> [AudioProc] {
    let sys = AudioObjectID(kAudioObjectSystemObject)
    return readIDList(sys, kAudioHardwarePropertyProcessObjectList).compactMap { obj in
        guard let pid = readScalar(obj, kAudioProcessPropertyPID, pid_t(0)), pid > 0 else { return nil }
        let bundle = readString(obj, kAudioProcessPropertyBundleID) ?? ""
        let running = (readScalar(obj, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0
        return AudioProc(objectID: obj, pid: pid, bundleID: bundle, playing: running)
    }
}

// Helper processes (e.g. "com.foo.app.helper") are grouped under their main app.
func mainBundleID(_ b: String) -> String {
    let lower = b.lowercased()
    for marker in [".helper", ".xpc", ".audiounit", ".plugin"] {
        if let r = lower.range(of: marker) { return String(b[b.startIndex..<r.lowerBound]) }
    }
    return b
}

@available(macOS 14.2, *)
func listApps() {
    var groups: [String: (name: String, bundle: String, pids: [Int32], playing: Bool)] = [:]
    let myPid = getpid()
    for p in audioProcesses() {
        if p.pid == myPid { continue }
        if p.bundleID.lowercased().hasPrefix("com.audioshare") { continue }
        if p.bundleID.hasPrefix("com.apple.") && ["com.apple.audio.coreaudiod", "com.apple.controlcenter", "com.apple.systemsound"].contains(where: { p.bundleID.hasPrefix($0) }) { continue }
        let key = p.bundleID.isEmpty ? "pid:\(p.pid)" : mainBundleID(p.bundleID)
        var name = ""
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: key).first, let n = app.localizedName {
            name = n
        } else if let app = NSRunningApplication(processIdentifier: p.pid), let n = app.localizedName {
            name = n
        }
        if name.isEmpty { name = key }
        var g = groups[key] ?? (name: name, bundle: key, pids: [], playing: false)
        g.pids.append(p.pid)
        g.playing = g.playing || p.playing
        groups[key] = g
    }
    let arr: [[String: Any]] = groups.values
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        .map { ["name": $0.name, "id": $0.bundle, "pids": $0.pids, "playing": $0.playing] }
    outJSON(arr)
}

// ---------------------------------------------------------------- capture
var tapID = AudioObjectID(kAudioObjectUnknown)
var aggID = AudioObjectID(kAudioObjectUnknown)
var procID: AudioDeviceIOProcID? = nil
var signalSource: DispatchSourceSignal? = nil

func cleanup() {
    if aggID != kAudioObjectUnknown {
        if let p = procID {
            AudioDeviceStop(aggID, p)
            AudioDeviceDestroyIOProcID(aggID, p)
        }
        AudioHardwareDestroyAggregateDevice(aggID)
        aggID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
        if #available(macOS 14.2, *) { AudioHardwareDestroyProcessTap(tapID) }
        tapID = AudioObjectID(kAudioObjectUnknown)
    }
}

func fail(_ msg: String, _ status: OSStatus = 0) -> Never {
    errLine("ERROR \(msg)\(status != 0 ? " (\(status))" : "")")
    cleanup()
    exit(1)
}

@available(macOS 14.2, *)
func capture(pids: [pid_t]) {
    let wanted = Set(pids)
    let objs = audioProcesses().filter { wanted.contains($0.pid) }.map { $0.objectID }
    if objs.isEmpty { fail("that app isn't using audio right now") }

    let desc = CATapDescription(stereoMixdownOfProcesses: objs)
    desc.uuid = UUID()
    desc.muteBehavior = .unmuted
    var st = AudioHardwareCreateProcessTap(desc, &tapID)
    if st != noErr { fail("could not create the audio tap", st) }

    guard let fmt = readScalar(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()) else {
        fail("could not read the tap format")
    }
    if fmt.mFormatID != kAudioFormatLinearPCM || (fmt.mFormatFlags & kAudioFormatFlagIsFloat) == 0 || fmt.mBitsPerChannel != 32 {
        fail("unexpected audio format")
    }
    let nonInterleaved = (fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    let channels = Int(max(1, fmt.mChannelsPerFrame))

    let sysObj = AudioObjectID(kAudioObjectSystemObject)
    guard let outDev = readScalar(sysObj, kAudioHardwarePropertyDefaultSystemOutputDevice, AudioDeviceID(0)),
          let outUID = readString(outDev, kAudioDevicePropertyDeviceUID) else {
        fail("no audio output device found")
    }
    let aggDesc: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Audio Share DAW capture",
        kAudioAggregateDeviceUIDKey: "audioshare-tap-" + UUID().uuidString,
        kAudioAggregateDeviceMainSubDeviceKey: outUID,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
        kAudioAggregateDeviceTapListKey: [[
            kAudioSubTapDriftCompensationKey: true,
            kAudioSubTapUIDKey: desc.uuid.uuidString
        ]]
    ]
    st = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
    if st != noErr { fail("could not create the capture device", st) }

    let out = FileHandle.standardOutput
    var scratch = [Float](repeating: 0, count: 8192)
    let queue = DispatchQueue(label: "audioshare.tap", qos: .userInteractive)
    st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, queue) { _, inInput, _, _, _ in
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInput))
        guard abl.count > 0 else { return }
        if !nonInterleaved && channels == 2 {
            let b = abl[0]
            if let d = b.mData, b.mDataByteSize > 0 {
                out.write(Data(bytes: d, count: Int(b.mDataByteSize)))
            }
            return
        }
        // Convert anything else to interleaved stereo.
        var frames = 0
        var getSample: (Int, Int) -> Float
        if nonInterleaved {
            frames = Int(abl[0].mDataByteSize) / 4
            getSample = { f, c in
                let idx = min(c, abl.count - 1)
                guard let p = abl[idx].mData?.assumingMemoryBound(to: Float.self) else { return 0 }
                return p[f]
            }
        } else {
            frames = Int(abl[0].mDataByteSize) / 4 / channels
            let p = abl[0].mData?.assumingMemoryBound(to: Float.self)
            getSample = { f, c in p?[f * channels + min(c, channels - 1)] ?? 0 }
        }
        if frames <= 0 { return }
        if scratch.count < frames * 2 { scratch = [Float](repeating: 0, count: frames * 2) }
        for f in 0..<frames {
            scratch[2 * f] = getSample(f, 0)
            scratch[2 * f + 1] = getSample(f, 1)
        }
        scratch.withUnsafeBytes { raw in
            out.write(Data(bytes: raw.baseAddress!, count: frames * 2 * 4))
        }
    }
    if st != noErr { fail("could not start capture", st) }
    st = AudioDeviceStart(aggID, procID)
    if st != noErr { fail("could not start capture", st) }

    errLine("FORMAT {\"rate\":\(Int(fmt.mSampleRate)),\"channels\":2}")
}

// ---------------------------------------------------------------- main
signal(SIGPIPE, SIG_IGN)
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "list"

if #available(macOS 14.2, *) {
    if mode == "list" {
        listApps()
        exit(0)
    }
    if mode == "capture" {
        let pids = args.dropFirst(2).compactMap { pid_t($0) }
        if pids.isEmpty { fail("no app given") }
        // Stop when Audio Share closes our input, or asks us to stop.
        signal(SIGTERM, SIG_IGN)
        signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        signalSource?.setEventHandler { cleanup(); exit(0) }
        signalSource?.resume()
        Thread.detachNewThread {
            while true {
                let d = FileHandle.standardInput.availableData
                if d.isEmpty { DispatchQueue.main.async { cleanup(); exit(0) }; return }
            }
        }
        capture(pids: pids)
        dispatchMain()
    }
    errLine("ERROR unknown mode")
    exit(2)
} else {
    if mode == "list" { outJSON(["error": "needs-macos-14.2"]); exit(0) }
    errLine("ERROR needs macOS 14.2 or newer")
    exit(1)
}
