// Audio Share - Windows app-audio capture helper.
// Uses Windows' per-process loopback capture (Windows 10 2004+) to copy the
// sound of one app (your DAW) and its child processes. No driver needed.
//
//   daw-capture.exe list              -> JSON list of apps with audio sessions (stdout)
//   daw-capture.exe capture <pid>     -> raw 32-bit float stereo 48 kHz PCM on stdout,
//                                        "FORMAT {...}" line on stderr once started
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <audioclientactivationparams.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <map>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")

static void errLine(const char* s) { fprintf(stderr, "%s\n", s); fflush(stderr); }
static void fail(const char* msg, HRESULT hr = S_OK) {
    if (hr != S_OK) fprintf(stderr, "ERROR %s (0x%08lx)\n", msg, (unsigned long)hr);
    else fprintf(stderr, "ERROR %s\n", msg);
    fflush(stderr);
    ExitProcess(1);
}

static std::string utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}
static std::string jsonEscape(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
        else if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o;
}

static std::wstring processName(DWORD pid) {
    std::wstring name;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (h) {
        wchar_t buf[MAX_PATH]; DWORD len = MAX_PATH;
        if (QueryFullProcessImageNameW(h, 0, buf, &len)) {
            std::wstring full(buf, len);
            size_t slash = full.find_last_of(L"\\/");
            name = slash == std::wstring::npos ? full : full.substr(slash + 1);
            if (name.size() > 4 && _wcsicmp(name.c_str() + name.size() - 4, L".exe") == 0) name.resize(name.size() - 4);
        }
        CloseHandle(h);
    }
    return name;
}

// ---------------------------------------------------------------- list
static int listApps() {
    IMMDeviceEnumerator* en = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (FAILED(hr)) { printf("[]\n"); return 0; }
    IMMDeviceCollection* devs = nullptr;
    std::map<DWORD, bool> found;   // pid -> playing
    if (SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devs))) {
        UINT count = 0; devs->GetCount(&count);
        for (UINT i = 0; i < count; i++) {
            IMMDevice* dev = nullptr;
            if (FAILED(devs->Item(i, &dev))) continue;
            IAudioSessionManager2* mgr = nullptr;
            if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) {
                IAudioSessionEnumerator* se = nullptr;
                if (SUCCEEDED(mgr->GetSessionEnumerator(&se))) {
                    int n = 0; se->GetCount(&n);
                    for (int k = 0; k < n; k++) {
                        IAudioSessionControl* ctl = nullptr;
                        if (FAILED(se->GetSession(k, &ctl))) continue;
                        IAudioSessionControl2* ctl2 = nullptr;
                        if (SUCCEEDED(ctl->QueryInterface(IID_PPV_ARGS(&ctl2)))) {
                            DWORD pid = 0;
                            if (ctl2->IsSystemSoundsSession() != S_OK && SUCCEEDED(ctl2->GetProcessId(&pid)) && pid != 0 && pid != GetCurrentProcessId()) {
                                AudioSessionState st = AudioSessionStateInactive;
                                ctl->GetState(&st);
                                found[pid] = found[pid] || st == AudioSessionStateActive;
                            }
                            ctl2->Release();
                        }
                        ctl->Release();
                    }
                    se->Release();
                }
                mgr->Release();
            }
            dev->Release();
        }
        devs->Release();
    }
    en->Release();

    std::string out = "[";
    bool first = true;
    for (auto& kv : found) {
        std::string name = utf8(processName(kv.first));
        if (name.empty()) continue;
        if (!first) out += ",";
        first = false;
        char pidbuf[32]; sprintf_s(pidbuf, "%lu", (unsigned long)kv.first);
        out += "{\"name\":\"" + jsonEscape(name) + "\",\"id\":\"" + jsonEscape(name) + "\",\"pids\":[" + pidbuf + "],\"playing\":" + (kv.second ? "true" : "false") + "}";
    }
    out += "]";
    printf("%s\n", out.c_str());
    fflush(stdout);
    return 0;
}

// ---------------------------------------------------------------- capture
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
    LONG refs = 1;
public:
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_FAIL;
    IAudioClient* client = nullptr;

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else if (riid == __uuidof(IAgileObject)) {
            *ppv = static_cast<IAgileObject*>(this);
        } else { *ppv = nullptr; return E_NOINTERFACE; }
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&refs);
        if (r == 0) delete this;
        return r;
    }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hrAct = E_FAIL;
        IUnknown* unk = nullptr;
        HRESULT hr = op->GetActivateResult(&hrAct, &unk);
        if (SUCCEEDED(hr) && SUCCEEDED(hrAct) && unk) {
            result = unk->QueryInterface(IID_PPV_ARGS(&client));
        } else {
            result = FAILED(hr) ? hr : hrAct;
        }
        if (unk) unk->Release();
        SetEvent(done);
        return S_OK;
    }
};

static DWORD WINAPI watchStdin(LPVOID) {
    char buf[64]; DWORD got = 0;
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    while (ReadFile(in, buf, sizeof(buf), &got, nullptr) && got > 0) {}
    ExitProcess(0);   // Audio Share closed our input: stop
    return 0;
}

static int capture(DWORD pid) {
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ActivateHandler* handler = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler, &op);
    if (FAILED(hr)) fail("could not start app capture (needs Windows 10 version 2004 or newer)", hr);
    if (WaitForSingleObject(handler->done, 10000) != WAIT_OBJECT_0) fail("app capture timed out");
    if (FAILED(handler->result) || !handler->client) fail("could not start app capture", handler->result);
    IAudioClient* client = handler->client;

    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = 2;
    fmt.nSamplesPerSec = 48000;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                            200000, 0, &fmt, nullptr);
    if (FAILED(hr)) fail("could not set up app capture", hr);

    HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = client->SetEventHandle(ready);
    if (FAILED(hr)) fail("could not set up app capture", hr);
    IAudioCaptureClient* cap = nullptr;
    hr = client->GetService(IID_PPV_ARGS(&cap));
    if (FAILED(hr)) fail("could not set up app capture", hr);
    hr = client->Start();
    if (FAILED(hr)) fail("could not start app capture", hr);

    _setmode(_fileno(stdout), _O_BINARY);
    errLine("FORMAT {\"rate\":48000,\"channels\":2}");
    CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);

    std::vector<float> zeros;
    for (;;) {
        WaitForSingleObject(ready, 100);
        UINT32 packet = 0;
        while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
            hr = cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) fail("capture stopped", hr);
            size_t bytes = (size_t)frames * fmt.nBlockAlign;
            const void* src = data;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                if (zeros.size() < (size_t)frames * 2) zeros.assign((size_t)frames * 2, 0.0f);
                src = zeros.data();
            }
            if (bytes && fwrite(src, 1, bytes, stdout) != bytes) ExitProcess(0);
            cap->ReleaseBuffer(frames);
        }
        fflush(stdout);
    }
}

int main(int argc, char** argv) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) fail("COM init failed", hr);
    std::string mode = argc > 1 ? argv[1] : "list";
    if (mode == "list") return listApps();
    if (mode == "capture") {
        if (argc < 3) fail("no app given");
        return capture((DWORD)strtoul(argv[2], nullptr, 10));
    }
    fail("unknown mode");
    return 2;
}
