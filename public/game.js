var statusElement = document.getElementById("status");
var progressElement = document.getElementById("progress");
var spinnerElement = document.getElementById('spinner');
var data_content;
var wasm_content;

const params = new URLSearchParams(window.location.search);

// Base URLs
// The engine binary requests /vcsky/ files by absolute URL; keep them same-origin.
const replaceFetch = (str) => str.replace(/^https?:\/\/[^/]+\/vcsky\//, "/vcsky/")
const replaceBR = "/vcbr/"

// Browser settings are stored separately from the game's own reVC configuration.
const SETTINGS_KEY = 'vcsky.browser-settings.v1';
const SETTINGS_DEFAULTS = {
    quality: 'custom',
    resolution: '800x600',
    maxFPS: 0,
    drawDistance: 1.8,
    trails: true,
    vsync: true,
    fullscreen: false,
};
function loadBrowserSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        if (!saved || typeof saved !== 'object') return { ...SETTINGS_DEFAULTS };
        const resolutions = ['640x480', '800x600', '1024x768', '1280x720', '1600x900'];
        const fps = Number(saved.maxFPS);
        const distance = Number(saved.drawDistance);
        return {
            quality: ['performance', 'balanced', 'high', 'custom'].includes(saved.quality) ? saved.quality : SETTINGS_DEFAULTS.quality,
            resolution: resolutions.includes(saved.resolution) ? saved.resolution : SETTINGS_DEFAULTS.resolution,
            maxFPS: Number.isFinite(fps) ? Math.max(0, Math.min(240, Math.round(fps))) : SETTINGS_DEFAULTS.maxFPS,
            drawDistance: Number.isFinite(distance) ? Math.max(0.8, Math.min(1.8, distance)) : SETTINGS_DEFAULTS.drawDistance,
            trails: typeof saved.trails === 'boolean' ? saved.trails : SETTINGS_DEFAULTS.trails,
            vsync: typeof saved.vsync === 'boolean' ? saved.vsync : SETTINGS_DEFAULTS.vsync,
            fullscreen: typeof saved.fullscreen === 'boolean' ? saved.fullscreen : SETTINGS_DEFAULTS.fullscreen,
        };
    } catch {
        return { ...SETTINGS_DEFAULTS };
    }
}
const browserSettings = loadBrowserSettings();
function saveBrowserSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(browserSettings));
    } catch (error) {
        console.warn('[settings] Could not save browser settings:', error);
    }
}
function setIniValue(ini, section, key, value) {
    const lines = ini.split(/\r?\n/);
    const sectionHeader = '[' + section + ']';
    const sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
    if (sectionStart < 0) return ini;

    let sectionEnd = sectionStart + 1;
    while (sectionEnd < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[sectionEnd])) {
        sectionEnd++;
    }

    const keyLine = key + '=';
    let keyIndex = -1;
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
        if (lines[i].startsWith(keyLine)) {
            keyIndex = i;
            break;
        }
    }

    if (keyIndex >= 0) lines[keyIndex] = keyLine + value;
    else lines.splice(sectionEnd, 0, keyLine + value);
    return lines.join('\n');
}
function buildConfiguredRevcIni(ini) {
    const [width, height] = browserSettings.resolution.split('x').map(Number);
    let configured = setIniValue(ini, 'VideoMode', 'Width', width);
    configured = setIniValue(configured, 'VideoMode', 'Height', height);
    configured = setIniValue(configured, 'Display', 'DrawDistance', Number(browserSettings.drawDistance).toFixed(6));
    configured = setIniValue(configured, 'Graphics', 'Trails', browserSettings.trails ? 1 : 0);
    configured = setIniValue(configured, 'Graphics', 'VSync', browserSettings.vsync ? 1 : 0);
    return configured;
}

// Explicit URL parameters take precedence over the saved browser preferences.
let autoFullScreen = params.has('fullscreen') ? params.get('fullscreen') !== '0' : false;
const CHEATS_KEY = 'vcsky.cheats';
let cheatsEnabled = params.get('cheats') === '1' || (() => {
    try { return localStorage.getItem(CHEATS_KEY) === '1'; } catch { return false; }
})();
const requestedFPS = Number(params.get('max_fps'));
let maxFPS = params.has('max_fps') && Number.isFinite(requestedFPS)
    ? Math.max(0, Math.min(240, Math.round(requestedFPS)))
    : browserSettings.maxFPS;

const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let isTouch = isMobile && window.matchMedia('(pointer: coarse)').matches;

document.body.dataset.isTouch = isTouch ? 1 : 0;

// The engine asks for pointer lock once it is fullscreen. On touch that freezes
// every pointer at 0,0, so drags measure zero and the sticks/menu swipes die.
if (isTouch) {
    Element.prototype.requestPointerLock = () => {};
}

const textDecoder = new TextDecoder();
let haveOriginalGame = true;

async function resumeAudioContexts() {
    const contexts = [];

    const moduleAudioContext = globalThis.Module?.SDL2?.audioContext;
    if (moduleAudioContext) {
        contexts.push(moduleAudioContext);
    }

    const openAlContext = globalThis.AL?.currentCtx?.audioCtx;
    if (openAlContext) {
        contexts.push(openAlContext);
    }

    for (const context of contexts) {
        if (context?.state === "suspended") {
            try {
                await context.resume();
            } catch (error) {
                console.warn("Audio resume failed:", error);
            }
        }
    }
}
// The game data is English-only; the UI language (src/i18n) does not change it.
data_content = `${replaceBR}vc-sky-en-v6.data`;
const data_index = `${replaceBR}vc-sky-en-v6.json`;
wasm_content = 'engine/vc-sky-en-v6.wasm';

async function loadData() {
    const indexResponse = await fetch(data_index, { cache: 'no-store' });
    if (!indexResponse.ok) {
        throw new Error("Failed to load data index: " + indexResponse.status + " " + indexResponse.url);
    }
    window.DATA_PACKAGE = await indexResponse.json();
    const dataSize = Number(window.DATA_PACKAGE.remote_package_size);
    const response = await fetch(data_content, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error("Failed to load data package: " + response.status + " " + response.url);
    }

    const expectedSize = Number(response.headers.get("Content-Length")) || dataSize;
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
        throw new Error("Invalid game package size in the OPFS index.");
    }
    const buffer = new Uint8Array(expectedSize);
    const reader = response.body.getReader();
    let receivedLength = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (receivedLength + value.length > buffer.length) {
            throw new Error("Game package is larger than its index declares.");
        }
        buffer.set(value, receivedLength);
        receivedLength += value.length;
        setStatus("Downloading...(" + receivedLength + "/" + expectedSize + ")");
    }
    if (receivedLength !== expectedSize) {
        throw new Error("Game package is incomplete: received " + receivedLength + " of " + expectedSize + " bytes.");
    }
    return buffer;
}

// Apply the selected FPS cap to the game's requestAnimationFrame loop.
function installFPSLimiter() {
    if (window.__vcFPSLimiterInstalled) return;
    let fpsFrames = 0;
    let fpsWindowStart = performance.now();
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const lastFrameByCallback = new WeakMap();
    window.requestAnimationFrame = function (callback) {
        const schedule = () => nativeRequestAnimationFrame((timestamp) => {
            const limit = maxFPS;
            if (!limit) {
                lastFrameByCallback.set(callback, timestamp);
                fpsFrames++;
                if (timestamp - fpsWindowStart >= 1000) {
                    const fpsStatus = document.getElementById('vc-fps-status');
                    if (fpsStatus) fpsStatus.textContent = 'FPS: ' + Math.round(fpsFrames * 1000 / (timestamp - fpsWindowStart));
                    fpsFrames = 0;
                    fpsWindowStart = timestamp;
                }
                callback(timestamp);
                return;
            }
            const interval = 1000 / limit;
            const last = lastFrameByCallback.get(callback) || 0;
            if (!last || timestamp - last >= interval) {
                lastFrameByCallback.set(callback, timestamp);
                fpsFrames++;
                if (timestamp - fpsWindowStart >= 1000) {
                    const fpsStatus = document.getElementById('vc-fps-status');
                    if (fpsStatus) fpsStatus.textContent = 'FPS: ' + Math.round(fpsFrames * 1000 / (timestamp - fpsWindowStart));
                    fpsFrames = 0;
                    fpsWindowStart = timestamp;
                }
                callback(timestamp);
            } else {
                schedule();
            }
        });
        return schedule();
    };
    window.__vcFPSLimiterInstalled = true;
}

async function startGame(e) {
    e.stopPropagation();
    await window.vcController?.connect();
    await resumeAudioContexts();

    if (autoFullScreen && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen().catch(() => {});
    }

    document.querySelector('.start-container').style.display = 'none';
    document.querySelector('.disclaimer').style.display = 'none';
    document.querySelector('.developed-by').style.display = 'none';

    const loadingScreen = document.querySelector('.loading-screen');
    document.querySelector('.click-to-play').style.display = 'none';
    document.querySelector('.loader-container').style.display = "flex";
    loadingScreen.hidden = false;
    const instanceStatus = document.getElementById('vc-instance-status');
    const instanceLight = document.getElementById('vc-instance-light');
    if (instanceStatus) instanceStatus.textContent = 'Starting game instance…';
    if (instanceLight) instanceLight.style.background = '#e8b339';

    window.__vcGameRuntimeReady = false;
    const fpsStatus = document.getElementById('vc-fps-status');
    if (fpsStatus) fpsStatus.textContent = 'FPS: loading';
    installFPSLimiter();
    await window.vcUserData?.prepareLaunch();
    const dataBuffer = await loadData();
    loadGame(dataBuffer);
}

function setStatus(text) {
    const loadingScreen = document.querySelector('.loading-screen');
    if (text && loadingScreen) loadingScreen.hidden = false;
    if (!text) {
        progressElement.hidden = true;
        spinnerElement.hidden = true;
        if (window.__vcGameRuntimeReady && loadingScreen) loadingScreen.hidden = true;
        return;
    }
    const match = text.match(/(.+)\((\d+\.?\d*)\/(\d+)\)/);
    if (match) {
        const [current, total] = match.slice(2, 4).map(Number);
        const percent = Math.min(100, Math.max(0, total > 0 ? current / total * 100 : 0));
        statusElement.textContent = t("loader.downloadingPercent", { percent: Math.round(percent) });
        progressElement.value = current;
        progressElement.max = total;
        progressElement.hidden = false;
        spinnerElement.hidden = false;
        const progressBarFill = spinnerElement.querySelector('.progress-bar-fill');
        if (progressBarFill) {
            progressBarFill.style.width = percent + '%';
        }
    } else {
        statusElement.textContent = text;
    }
};

async function loadGame(data) {
    // Keep the player's saved controls, then apply browser graphics settings for this launch.
    const baseIni = localStorage.getItem('vcsky.revc.ini') || revc_iniDefault;
    const useClassicControls = baseIni === revc_iniDefault && window.vcController?.connected;
    const configuredIni = buildConfiguredRevcIni(baseIni);
    const gameIni = useClassicControls ? configuredIni.replace(/^Method=\d+$/m, 'Method=1') : configuredIni;
    var Module = {
        onRuntimeInitialized: () => {
            window.__vcGameRuntimeReady = true;
            const instanceStatus = document.getElementById('vc-instance-status');
            const instanceLight = document.getElementById('vc-instance-light');
            if (instanceStatus) instanceStatus.textContent = 'Game instance running';
            if (instanceLight) instanceLight.style.background = '#3ecf6e';
            const fpsStatus = document.getElementById('vc-fps-status');
            if (fpsStatus) fpsStatus.textContent = 'FPS: —';
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const loadingScreen = document.querySelector('.loading-screen');
                if (loadingScreen) loadingScreen.hidden = true;
            }));
        },
        mainCalled: () => {
            try {
                Module.FS.unlink("/vc-assets/local/revc.ini");
                Module.FS.createDataFile("/vc-assets/local/revc.ini", 0, gameIni, gameIni.length);
            } catch (e) {
                console.error('mainCalled error:', e);
            }
        },
        syncRevcIni: () => {
            try {
                const path = Module.FS.lookupPath("/vc-assets/local/revc.ini");
                if (path && path.node && path.node.contents) {
                    localStorage.setItem('vcsky.revc.ini', textDecoder.decode(path.node.contents));
                }
            } catch (e) {
                console.error('syncRevcIni error:', e);
            }
        },
        preRun: [() => window.vcUserData?.installIntoFS(Module.FS)],
        postRun: [],
        print: (...args) => console.log(args.join(' ')),
        printErr: (...args) => console.error(args.join(' ')),
        getPreloadedPackage: () => {
            return data.buffer;
        },
        canvas: function () {
            const canvas = document.getElementById('canvas');
            canvas.addEventListener('webglcontextlost', (e) => {
                statusElement.textContent = t("loader.webglLost");
                e.preventDefault();
            });
            canvas.addEventListener('pointerdown', () => {
                resumeAudioContexts();
            });
            return canvas;
        }(),
        setStatus,
        totalDependencies: 0,
        monitorRunDependencies: (num) => {
            Module.totalDependencies = Math.max(Module.totalDependencies, num);
            Module.setStatus(`Preparing... (${Module.totalDependencies - num}/${Module.totalDependencies})`);
        },
        hotelMission: () => {
        },
    };
    Module.log = Module.print;
    Module.instantiateWasm = async (
        info,
        receiveInstance,
    ) => {
        const wasm = await (await fetch(wasm_content ? wasm_content : "index.wasm")).arrayBuffer();
        const module = await WebAssembly.instantiate(wasm, info);
        return receiveInstance(module.instance, module);
    };
    window.onerror = (message) => {
        Module.setStatus(t("errors.generic", { message }));
        spinnerElement.hidden = true;
    };
    Module.arguments = window.location.search
        .slice(1)
        .split('&')
        .filter(Boolean)
        .map(decodeURIComponent);
    window.onbeforeunload = function (event) {
        event.preventDefault();
        return '';
    };

    window.Module = Module;
    const script = document.createElement('script');
    script.async = true;
    script.addEventListener('load', () => {
        resumeAudioContexts();
    });
    script.src = 'index.js';
    document.body.appendChild(script);

    document.body.classList.add('gameIsStarted');

    const emulator = new GamepadEmulator();
    window.vcController?.attach(emulator);
    if (!isTouch) return;
    const gamepad = emulator.AddEmulatedGamepad(0, true);
    const gamepadEmulatorConfig = {
        directions: { up: true, down: true, left: true, right: true },
        dragDistance: isTouch ? 85 : 100,
        tapTarget: move,
        lockTargetWhilePressed: true,
        xAxisIndex: 0,
        yAxisIndex: 1,
        swapAxes: false,
        invertX: false,
        invertY: false,
    };
    emulator.AddDisplayJoystickEventListeners(0, [gamepadEmulatorConfig]);
    const gamepadEmulatorConfig1 = {
        directions: { up: true, down: true, left: true, right: true },
        dragDistance: 100,
        tapTarget: look,
        lockTargetWhilePressed: true,
        xAxisIndex: 2,
        yAxisIndex: 3,
        swapAxes: false,
        invertX: false,
        invertY: false,
    };
    emulator.AddDisplayJoystickEventListeners(0, [gamepadEmulatorConfig1]);

    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 9,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.menu'),
    }]);
    // Opening the menu leaves fullscreen so the browser bars are reachable again.
    document.querySelector('.touch-control.menu').addEventListener('pointerdown', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
    });
    // Back in the game after the menu: return to fullscreen.
    new MutationObserver(() => {
        if (isTouch && document.body.dataset.stateMenu === '0' && !document.fullscreenElement) {
            document.documentElement.requestFullscreen?.().catch(() => {});
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-state-menu'] });
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 3,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.car.getIn'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 0,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.run'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 1,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fist'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 5,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.drift'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 2,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.jump'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 4,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.mobile'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 11,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.job'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 4,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.radio'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 7,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.weapon'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 8,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.camera'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 10,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.horn'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 7,
        buttonIndexes: [1, 7],
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fireRight'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 6,
        buttonIndexes: [1, 6],
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fireLeft'),
    }]);
}

const enableCheatsCheckbox = document.getElementById('enable-cheats');
if (enableCheatsCheckbox) {
    enableCheatsCheckbox.checked = cheatsEnabled;
    enableCheatsCheckbox.addEventListener('change', (e) => {
        cheatsEnabled = e.target.checked;
        try { localStorage.setItem(CHEATS_KEY, cheatsEnabled ? '1' : '0'); } catch {}
    });
}

const clickToPlay = document.querySelector('.click-to-play');
const clickLink = clickToPlay.querySelector('button');
clickToPlay.addEventListener('click', (e) => {
    if (clickLink.disabled || window.__gtaGameReady !== true) {
        return;
    }
    if (e.target === clickToPlay || e.target === clickLink) {
        startGame(e);
    }
});

// Wires up window.syncfs, which public/modules/fs.js calls into for save-game
// persistence to IndexedDB (see FS.syncfs -> IDBFS.syncfs -> window.syncfs).
// No listeners are registered: local saves work through IDBFS's own sync path;
// nothing here needs to reach outside the browser.
wrapIDBFS(console.log);

const clickToPlayButton = document.getElementById('click-to-play-button');
if (!window.__gtaGameReady) {
    clickToPlayButton.classList.add('disabled');
    clickToPlayButton.disabled = true;
}

const revc_iniDefault = `
[VideoMode]
Width=800
Height=600
Depth=32
Subsystem=0
Windowed=0
[Controller]
HeadBob1stPerson=0
HorizantalMouseSens=0.002500
InvertMouseVertically=1
DisableMouseSteering=1
Vibration=0
Method=${isTouch ? '1' : '0'}
InvertPad=0
JoystickName=
PadButtonsInited=0
[Audio]
SfxVolume=36
MusicVolume=37
MP3BoostVolume=0
Radio=0
SpeakerType=0
Provider=0
DynamicAcoustics=1
[Display]
Brightness=256
DrawDistance=1.800000
Subtitles=0
ShowHud=1
RadarMode=0
ShowLegends=0
PedDensity=1.200000
CarDensity=1.200000
CutsceneBorders=1
FreeCam=0
[Graphics]
AspectRatio=0
VSync=1
Trails=1
FrameLimiter=0
MultiSampling=0
IslandLoading=0
PS2AlphaTest=1
ColourFilter=2
MotionBlur=0
VehiclePipeline=0
NeoRimLight=0
NeoLightMaps=0
NeoRoadGloss=0
[General]
SkinFile=$$""
Language=0
DrawVersionText=0
NoMovies=0
[CustomPipesValues]
PostFXIntensity=1.000000
NeoVehicleShininess=1.000000
NeoVehicleSpecularity=1.000000
RimlightMult=1.000000
LightmapMult=1.000000
GlossMult=1.000000
[Rendering]
BackfaceCulling=1
NewRenderer=1
[Draw]
ProperScaling=1
FixRadar=1
FixSprites=1
[Bindings]
PED_FIREWEAPON=mouse:LEFT,2ndKbd:PAD5
PED_CYCLE_WEAPON_RIGHT=2ndKbd:PADENTER,mouse:WHLDOWN,kbd:E
PED_CYCLE_WEAPON_LEFT=kbd:PADDEL,mouse:WHLUP,2ndKbd:Q
GO_FORWARD=kbd:UP,2ndKbd:W
GO_BACK=kbd:DOWN,2ndKbd:S
GO_LEFT=2ndKbd:A,kbd:LEFT
GO_RIGHT=kbd:RIGHT,2ndKbd:D
PED_SNIPER_ZOOM_IN=kbd:PGUP,2ndKbd:Z,mouse:WHLUP
PED_SNIPER_ZOOM_OUT=kbd:PGDN,2ndKbd:X,mouse:WHLDOWN
VEHICLE_ENTER_EXIT=kbd:ENTER,2ndKbd:F
CAMERA_CHANGE_VIEW_ALL_SITUATIONS=kbd:HOME,2ndKbd:V
PED_JUMPING=kbd:RCTRL,2ndKbd:SPC
PED_SPRINT=2ndKbd:LSHIFT,kbd:RSHIFT
PED_LOOKBEHIND=2ndKbd:CAPSLK,mouse:MIDDLE,kbd:PADINS
PED_DUCK=kbd:C
PED_ANSWER_PHONE=kbd:TAB
VEHICLE_FIREWEAPON=kbd:PADINS,2ndKbd:LCTRL,mouse:LEFT
VEHICLE_ACCELERATE=2ndKbd:W
VEHICLE_BRAKE=2ndKbd:S
VEHICLE_CHANGE_RADIO_STATION=kbd:INS,2ndKbd:R
VEHICLE_HORN=2ndKbd:LSHIFT,kbd:RSHIFT
TOGGLE_SUBMISSIONS=kbd:PLUS,2ndKbd:CAPSLK
VEHICLE_HANDBRAKE=kbd:RCTRL,2ndKbd:SPC,mouse:RIGHT
PED_1RST_PERSON_LOOK_LEFT=kbd:PADLEFT
PED_1RST_PERSON_LOOK_RIGHT=kbd:PADHOME
VEHICLE_LOOKLEFT=kbd:PADEND,2ndKbd:Q
VEHICLE_LOOKRIGHT=kbd:PADDOWN,2ndKbd:E
VEHICLE_LOOKBEHIND=mouse:MIDDLE
VEHICLE_TURRETLEFT=kbd:PADLEFT
VEHICLE_TURRETRIGHT=kbd:PAD5
VEHICLE_TURRETUP=kbd:PADPGUP,2ndKbd:UP
VEHICLE_TURRETDOWN=kbd:PADRIGHT,2ndKbd:DOWN
PED_CYCLE_TARGET_LEFT=kbd:[,2ndKbd:PADEND
PED_CYCLE_TARGET_RIGHT=2ndKbd:],kbd:PADDOWN
PED_CENTER_CAMERA_BEHIND_PLAYER=kbd:#
PED_LOCK_TARGET=kbd:DEL,mouse:RIGHT,2ndKbd:PADRIGHT
NETWORK_TALK=kbd:T
PED_1RST_PERSON_LOOK_UP=kbd:PADPGUP
PED_1RST_PERSON_LOOK_DOWN=kbd:PADUP
_CONTROLLERACTION_36=
TOGGLE_DPAD=
SWITCH_DEBUG_CAM_ON=
TAKE_SCREEN_SHOT=
SHOW_MOUSE_POINTER_TOGGLE=
UNKNOWN_ACTION=

`;



// Settings drawer: changes are persisted and applied the next time the game starts.
(() => {
    const panel = document.getElementById('config-panel');
    const openButton = document.getElementById('vc-settings-open');
    const closeButton = document.getElementById('vc-settings-close');
    const quality = document.getElementById('config-quality');
    const resolution = document.getElementById('config-resolution');
    const fps = document.getElementById('config-max-fps');
    const drawDistance = document.getElementById('config-draw-distance');
    const drawDistanceValue = document.getElementById('config-draw-distance-value');
    const trails = document.getElementById('config-trails');
    const vsync = document.getElementById('config-vsync');
    const fullscreen = document.getElementById('config-fullscreen');
    const fullscreenButton = document.getElementById('vc-fullscreen-toggle');

    if (!panel || !openButton) return;

    const presets = {
        performance: { resolution: '640x480', drawDistance: 0.8, trails: false, vsync: false },
        balanced: { resolution: '800x600', drawDistance: 1.2, trails: true, vsync: true },
        high: { resolution: '800x600', drawDistance: 1.8, trails: true, vsync: true },
    };
    const refreshDrawDistance = () => {
        if (drawDistanceValue && drawDistance) {
            drawDistanceValue.textContent = Number(drawDistance.value).toFixed(1) + '×';
        }
    };
    const syncControls = () => {
        if (quality) quality.value = browserSettings.quality;
        if (resolution) resolution.value = browserSettings.resolution;
        if (fps) fps.value = String(maxFPS);
        if (drawDistance) drawDistance.value = String(browserSettings.drawDistance);
        if (trails) trails.checked = browserSettings.trails;
        if (vsync) vsync.checked = browserSettings.vsync;
        if (fullscreen) fullscreen.checked = autoFullScreen;
        refreshDrawDistance();
    };
    const persistControls = (manualGraphicsChange = false) => {
        if (resolution) browserSettings.resolution = resolution.value;
        if (drawDistance) {
            browserSettings.drawDistance = Math.max(0.8, Math.min(1.8, Number(drawDistance.value) || 1.8));
        }
        if (trails) browserSettings.trails = trails.checked;
        if (vsync) browserSettings.vsync = vsync.checked;
        if (fps) {
            maxFPS = Math.max(0, Math.min(240, Number(fps.value) || 0));
            browserSettings.maxFPS = maxFPS;
        }
        if (fullscreen) {
            autoFullScreen = fullscreen.checked;
            browserSettings.fullscreen = autoFullScreen;
        }
        if (manualGraphicsChange && quality) quality.value = 'custom';
        if (quality) browserSettings.quality = quality.value;
        saveBrowserSettings();
        refreshDrawDistance();
    };
    const applyPreset = () => {
        const preset = presets[quality?.value];
        if (!preset) {
            persistControls(false);
            return;
        }
        if (resolution) resolution.value = preset.resolution;
        if (drawDistance) drawDistance.value = String(preset.drawDistance);
        if (trails) trails.checked = preset.trails;
        if (vsync) vsync.checked = preset.vsync;
        persistControls(false);
    };

    syncControls();
    quality?.addEventListener('change', applyPreset);
    for (const control of [resolution, drawDistance, trails, vsync]) {
        control?.addEventListener(control === drawDistance ? 'input' : 'change', () => persistControls(true));
    }
    fps?.addEventListener('change', () => persistControls(false));
    fullscreen?.addEventListener('change', () => persistControls(false));

    const setPanelOpen = (open) => {
        panel.classList.toggle('is-open', open);
        openButton.setAttribute('aria-expanded', String(open));
    };
    openButton.addEventListener('click', () => setPanelOpen(!panel.classList.contains('is-open')));
    closeButton?.addEventListener('click', () => setPanelOpen(false));
    document.addEventListener('pointerdown', (event) => {
        if (panel.classList.contains('is-open') &&
            !panel.contains(event.target) && !openButton.contains(event.target)) {
            setPanelOpen(false);
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && panel.classList.contains('is-open')) setPanelOpen(false);
    });

    const updateFullscreenLabel = () => {
        if (fullscreenButton) {
            fullscreenButton.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
        }
    };
    fullscreenButton?.addEventListener('click', async () => {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
        } catch (error) {
            console.warn('[fullscreen] Toggle failed:', error);
        }
    });
    document.addEventListener('fullscreenchange', updateFullscreenLabel);
    updateFullscreenLabel();
})();