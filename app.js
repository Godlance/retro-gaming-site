"use strict";

let emulator = null;
let v86gl = null;
let stateOperationInProgress = false;

const R2_URL_1 = "https://retrogamingsiteresource.dpdns.org";
const R2_URL_2 = "https://resource2.19930724.xyz";

// Game configurations
const GAMES = {
    'heros_3': {
        name: 'Heroes of Might and Magic 3',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_1 + '/game/heros3/heros3.img.zst',
        size: 408944640,
        stateurl: R2_URL_1 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_heros3.bin.zst',
    },
    'red-alert-2': {
        name: 'Red Alert 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/ra2/ra2.img.zst',
        size: 1363148800,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_ra2.bin.zst',
    },
    'yuri': {
        name: 'Yuri\'s Revenge',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/yuri/yuri.img.zst',
        size: 1363148800,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_yuri.bin.zst',
    },
    'baldurs_gate_2': {
        name: 'Baldur\'s Gate 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_1 + '/game/baldurgate2/baldurgate2.img.zst',
        size: 3221225472,
        stateurl: R2_URL_1 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_baldursgate2.bin.zst',
    },
    'diablo_2': {
        name: 'Diablo 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_1 + '/game/diablo2/diablo2.img.zst',
        size: 2222981120,
        stateurl: R2_URL_1 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_diablo2.bin.zst',
    },
    'theme_hospital': {
        name: 'Theme Hospital',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/themehospital/themehospital.img.zst',
        size: 293601280,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_themehospital.bin.zst',
    },
    'starcraft': {
        name: 'StarCraft',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/starcraft/starcraft.img.zst',
        size: 367001600,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_starcraft.bin.zst',
    },
    'commandos_1': {
        name: 'Commandos I',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/commandos1/commandos1.img.zst',
        size: 157286400,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_commandos1.bin.zst',
    },
    'Diablo_1': {
        name: 'Diablo 1',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/diablo1/diablo1.img.zst',
        size: 167772160,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_diablo1.bin.zst',
    },
    'richman_4': {
        name: 'Richman 4 (大富翁4)',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/richman4/richman4.img.zst',
        size: 314572800,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_richman4.bin.zst',
    },
    'rollercoaster_tycoon_2': {
        name: 'Rollercoaster Tycoon 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/rollercoaster2/rollercoaster2.img.zst',
        size: 765460480,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_rollercoaster2.bin.zst',
    },
    'fallout_2': {
        name: 'Fallout 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/fallout2/fallout2.img.zst',
        size: 618659840,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_fallout2.bin.zst',
    },
    'age_of_empires_2': {
        name: 'Age of Empires 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_1 + '/game/ageofempires2/ageofempires2.img.zst',
        size: 193986560,
        stateurl: R2_URL_1 + '/windows98/states/windows98_audio_vga_2d_multidisk_ageofempires2.bin.zst',
    },
    'civilization_2': {
        name: 'Civilization 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_1 + '/game/civilization2/civilization.img.zst',
        size: 52428800,
        stateurl: R2_URL_1 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_civilization2.bin.zst',
    },
    'planescape_torment': {
        name: 'Planescape: Torment',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_2 + '/game/torment/torment.img.zst',
        size: 2621440000,
        stateurl: R2_URL_2 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_torment.bin.zst',
    },
    'simcity_3000': {
        name: 'SimCity 3000',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_2 + '/game/simcity3000/simcity3000.img.zst',
        size: 1572864000,
        stateurl: R2_URL_2 + '/windows98/states/windows98_audio_vga_2d_multidisk_simcity3000.bin.zst',
    },
    'icewind_dale_1': {
        name: 'Icewind Dale 1',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_2 + '/game/icewinddale1/icewinddale1.img.zst',
        size: 2621440000,
        stateurl: R2_URL_2 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_icewinddale1.bin.zst',
    },
    'need_for_speed_3': {
        name: 'Need for Speed 3',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_2 + '/game/nfs3/nfs3.img.zst',
        size: 2097152000,
        stateurl: R2_URL_2 + '/windows98/states/windows98_audio_vga_2d_multidisk_nfs3.bin.zst',
    },
    'dino_crisis': {
        name: 'Dino Crisis',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_2 + '/game/dinocrisis/dinocrisis.img.zst',
        size: 2097152000,
        stateurl: R2_URL_2 + '/windows98/states/windows98_audio_vga_2d_multidisk_dinocrisis.bin.zst',
    },
    'resident_evil_2': {
        name: 'Resident Evil 2',
        memorySize: 256 * 1024 * 1024,
        systemDisk: '/windows98/windows98multidisk/windows98hdd_C_512MB/windows98hdd_C_512MB.img.zst',
        systemDiskSize: 536870912,
        disk: R2_URL_2 + '/game/residentevil2/residentevil2.img.zst',
        size: 4294967296,
        stateurl: R2_URL_2 + '/windows98/states/windows98_audio_vga_2d_multidisk_residentevil2.bin.zst',
    },
    'maplestory': {
        name: 'MapleStory v83',
        memorySize: 1024 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_2 + '/game/maplestory/maplestory.img.zst',
        size: 2202009600,
        stateurl: R2_URL_2 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_maplestory.bin.zst',
    },
    'warcraft3': {
        name: 'Warcraft III',
        memorySize: 1024 * 1024 * 1024,
        systemDisk: '/windowsxp/windowsxpmultidisk/windowsxp_multidisk_C_2G.img.zst',
        systemDiskSize: 2147483648,
        disk: R2_URL_2 + '/game/warcraft3/warcraft3.img.zst',
        size: 2634022912,
        stateurl: R2_URL_2 + '/windowsxp/states/windowsxp_audio_vga_2d_multidisk_warcraft3.bin.zst',
    }
};

const progressContainer = document.getElementById("progress_container");
const progressBar = document.getElementById("progress_bar");
const statusText = document.getElementById("status_text");
const CLICK_STORAGE_KEY = "retro-gaming-site:play-counts:v1";
const GAME_COVERS = window.RETRO_GAME_COVERS || {};
const GAME_PAGE_META = {
    heros_3: ["1999", "Strategy"], "red-alert-2": ["2000", "Strategy"], yuri: ["2001", "Strategy"],
    baldurs_gate_2: ["2000", "RPG"], diablo_2: ["2000", "Action RPG"], theme_hospital: ["1997", "Simulation"],
    starcraft: ["1998", "Strategy"], commandos_1: ["1998", "Tactics"], Diablo_1: ["1997", "Action RPG"],
    richman_4: ["1998", "Board game"], rollercoaster_tycoon_2: ["2002", "Simulation"], fallout_2: ["1998", "RPG"],
    age_of_empires_2: ["1999", "Strategy"], civilization_2: ["1996", "Strategy"], planescape_torment: ["1999", "RPG"],
    simcity_3000: ["1999", "Simulation"], icewind_dale_1: ["2000", "RPG"],
    need_for_speed_3: ["1998", "Racing"], dino_crisis: ["2000", "Survival"], resident_evil_2: ["1999", "Survival"],
    maplestory: ["2003", "MMORPG"], warcraft3: ["2002", "Strategy"]
};
const COVER_PALETTES = [
    ["#2c351b", "#a4cf54"], ["#321c1b", "#d3614f"], ["#172f35", "#55abc2"], ["#312541", "#9c70d2"],
    ["#3b2c19", "#d79a48"], ["#15352d", "#49bf96"], ["#3b1c2b", "#cf5985"], ["#24284a", "#6f7ee0"]
];

function incrementPlayCount(gameId) {
    let counts = {};
    try { counts = JSON.parse(localStorage.getItem(CLICK_STORAGE_KEY) || "{}"); } catch (err) { counts = {}; }
    counts[gameId] = Number(counts[gameId] || 0) + 1;
    try { localStorage.setItem(CLICK_STORAGE_KEY, JSON.stringify(counts)); } catch (err) { console.warn("Could not persist play count", err); }
    return counts[gameId];
}

function gameCoverStyle(gameId) {
    let hash = 0;
    for (let i = 0; i < gameId.length; i += 1) hash = ((hash << 5) - hash + gameId.charCodeAt(i)) | 0;
    const palette = COVER_PALETTES[Math.abs(hash) % COVER_PALETTES.length];
    return `--cover-a:${palette[0]};--cover-b:${palette[1]}`;
}

function gameInitials(name) {
    return name.replace(/[^A-Za-z0-9\s]/g, " ").trim().split(/\s+/).slice(0, 3)
        .map(function(word) { return word.charAt(0); }).join("").toUpperCase();
}

function populateGamePage(gameId, game) {
    const meta = GAME_PAGE_META[gameId] || ["Classic", "PC game"];
    const platform = game.systemDisk.indexOf("windowsxp") !== -1 ? "Windows XP" : "Windows 98";
    const count = incrementPlayCount(gameId);
    document.title = `${game.name} — Retro Gaming Site`;
    document.getElementById("game_title").textContent = game.name;
    document.getElementById("game_platform").textContent = platform;
    document.getElementById("game_meta").textContent = `${meta[0]} · ${meta[1]} · v86 browser edition`;
    document.getElementById("play_count").textContent = count;
    document.getElementById("about_title").textContent = `${game.name}, preserved.`;
    document.getElementById("game_description").textContent = `${game.name} is preserved in a ready-to-play ${platform} environment. The complete system runs locally in your browser through v86 and WebAssembly, with downloadable emulator states so you can return to your session later.`;
    const accountPanel = document.getElementById("game_account_panel");
    if (accountPanel) accountPanel.hidden = gameId !== "maplestory";
    const cover = document.getElementById("mini_cover");
    cover.setAttribute("style", gameCoverStyle(gameId));
    const coverPath = GAME_COVERS[gameId];
    if (coverPath) {
        cover.classList.add("has-image");
        const image = document.createElement("img");
        image.className = "cover-image";
        image.src = coverPath;
        image.alt = "";
        cover.prepend(image);
        cover.querySelector("span").textContent = "";
    } else {
        cover.querySelector("span").textContent = gameInitials(game.name);
    }

    if (gameId === "diablo_2") {
        const customControls = document.getElementById("custom_controls");
        const button = document.createElement("button");
        button.className = "control-button";
        button.type = "button";
        button.innerHTML = '<span class="control-icon" aria-hidden="true">◇</span><span>D2 save tools</span>';
        button.addEventListener("click", function() {
            const event = new CustomEvent("retro:game-action", { cancelable: true, detail: { gameId, actionId: "save-files", emulator } });
            window.dispatchEvent(event);
            if (!event.defaultPrevented) updateStatus("Diablo II save-file hook is ready for the next integration step");
        });
        customControls.appendChild(button);
    }
}

function renderGamesList() {
    const gamesList = document.getElementById("games_list");
    if (!gamesList) return;

    gamesList.replaceChildren();

    Object.entries(GAMES).forEach(function([gameId, game]) {
        const gameItem = document.createElement("div");
        gameItem.className = "game-item";
        gameItem.dataset.game = gameId;

        const gameTitle = document.createElement("div");
        gameTitle.className = "game-title";
        gameTitle.textContent = game.name;

        const launchButton = document.createElement("button");
        launchButton.className = "launch-btn";
        launchButton.type = "button";
        launchButton.textContent = "Launch";
        launchButton.setAttribute("aria-label", "Launch " + game.name);
        launchButton.addEventListener("click", function() {
            launchGameMultiDisk(gameId);
        });

        gameItem.append(gameTitle, launchButton);
        gamesList.appendChild(gameItem);
    });
}

function showProgress() {
    progressContainer.classList.remove("hidden");
    progressBar.style.width = "0%";
}

function updateProgress(percent, text) {
    progressBar.style.width = percent + "%";
    if (text) statusText.textContent = text;
}

function hideProgress() {
    progressContainer.classList.add("hidden");
}

function waitForGuest(milliseconds) {
    return new Promise(function(resolve) {
        setTimeout(resolve, milliseconds);
    });
}

async function refreshMapleStoryNetwork(activeEmulator) {
    try {
        await waitForGuest(4000);
        if (emulator !== activeEmulator) return;

        await activeEmulator.keyboard_send_scancodes([
            0xE0, 0x5B,
            0x13, 0x93,
            0xE0, 0xDB,
        ], 50);
        await waitForGuest(800);
        if (emulator !== activeEmulator) return;

        await activeEmulator.keyboard_send_text("cmd", 50);
        await activeEmulator.keyboard_send_keys([13]);
        await waitForGuest(1500);
        if (emulator !== activeEmulator) return;

        await activeEmulator.keyboard_send_text("ipconfig /release", 35);
        await activeEmulator.keyboard_send_keys([13]);
        await waitForGuest(2500);
        if (emulator !== activeEmulator) return;

        await activeEmulator.keyboard_send_text("ipconfig /renew", 35);
        await activeEmulator.keyboard_send_keys([13]);
        console.info("MapleStory guest network refresh commands sent");
    } catch (error) {
        console.error("Failed to refresh MapleStory guest network:", error);
    }
}

function startEmulator9xMultiDisk(gameId) {

    const game = GAMES[gameId];

    if (emulator) {
        emulator.stop();
        emulator.destroy();
        emulator = null;
        v86gl = null;

        const glCanvas = document.getElementById("v86gl_canvas");
        if (glCanvas) {
            glCanvas.style.display = "none";
        }
        const d3dCanvas = document.getElementById("d3d_webgpu_canvas");
        if (d3dCanvas) {
            d3dCanvas.style.display = "none";
        }
    }

    emulator = new V86({
        memory_size: game.memorySize,
        vga_memory_size: 16 * 1024 * 1024,
        bios: { url: "bios/seabios.bin" },
        vga_bios: { url: "bios/vgabios.bin" },
        wasm_path: "v86.wasm",
        screen_container: document.getElementById("screen_container"),
        hda: {
            url: R2_URL_1 + game.systemDisk,
            async: true,
            size: game.systemDiskSize,
            fixed_chunk_size: 1024 * 1024,
            use_parts: true,
        },
        hdb: {
            url: game.disk,
            async: true,
            size: game.size,
            fixed_chunk_size: 1024 * 1024,
            use_parts: true,
        },
        initial_state: {
            url: game.stateurl,
        },
        acpi: false,
        net_device: {
            type : "ne2k",
            relay_url: "wss://relay.widgetry.org/"
        },
        preserve_mac_from_state_image: false,
        mac_address_translation: true,
        v86gl_pci: {
            port: 0xF100,
            maxBatchBytes: 16 * 1024 * 1024
        },
        preserve_fixed_proportions: true,
        boot_order: 0x213,
        audio: true,
        autostart: true
    });
    attachEmulatorListeners(emulator, gameId);
}

function attachEmulatorListeners(emulator, gameId) {
    const glCanvas = document.getElementById("v86gl_canvas");
    // A game directory only ever loads one of d3d8.dll/d3d9.dll/opengl32
    // proxy (see docs/d3d9-webgpu-implementation-plan.zh-CN.md section 4.6),
    // so the D3D8 and D3D9 executors share this one overlay canvas rather
    // than each getting a dedicated element. Both bridge-side executor
    // instances are lazy (no WebGPU context is touched until the first real
    // batch arrives), so only the backend the guest actually drives ever
    // configures the shared canvas.
    const d3dCanvas = document.getElementById("d3d_webgpu_canvas");
    let glCanvasObserver = null;

    function syncGLCanvasPosition() {
        if (!v86gl || typeof v86gl.positionCanvas !== "function") return;
        // v86 changes the VGA canvas size after the bridge is created. Refresh
        // the reference and calculate the overlay from the final canvas rect.
        if (typeof v86gl.findScreenCanvas === "function") {
            v86gl.screenCanvas = v86gl.findScreenCanvas();
        }
        v86gl.positionCanvas();
    }

    const installV86GLBridge =
        typeof installV86GLNetworkBridge === "function" ? installV86GLNetworkBridge : null;

    if (glCanvas && installV86GLBridge) {
        try {
            v86gl = installV86GLBridge(emulator, glCanvas, {
                gl4es: window.GL4ES,
                d3dCanvas: d3dCanvas,
            });
            window.v86gl = v86gl;

            const screenCanvas = document.querySelector(
                "#screen_container canvas:not(#v86gl_canvas):not(#d3d_webgpu_canvas)");
            if (screenCanvas && typeof ResizeObserver === "function") {
                glCanvasObserver = new ResizeObserver(function() {
                    requestAnimationFrame(syncGLCanvasPosition);
                });
                glCanvasObserver.observe(screenCanvas);
                glCanvasObserver.observe(document.getElementById("screen_container"));
            }
        } catch (err) {
            console.warn("Failed to start v86 GL network bridge:", err);
        }
    }

    emulator.add_listener("screen-set-size", function() {
        requestAnimationFrame(syncGLCanvasPosition);
    });

    emulator.add_listener("emulator-loaded", function() {
        const pci = emulator.v86 && emulator.v86.cpu && emulator.v86.cpu.devices.v86gl_pci;
        if (!pci) {
            console.error("[v86gl] PCI device is missing from this libv86.js build");
        }
        if (gameId === "maplestory") {
            refreshMapleStoryNetwork(emulator);
        }
    });

    emulator.add_listener("download-progress", function(e) {

        showProgress();

        if (e.total) {
            const percent = Math.floor((e.loaded / e.total) * 100);
            updateProgress(percent, `Loading game resource files ... ${percent}%`);
        } else {
            updateProgress(0, `Loading game resource files ...`);
        }
    });

    emulator.add_listener("emulator-ready", function() {
        hideProgress();
        updateStatus("Emulator ready — click the screen to capture your mouse");
        const placeholder = document.getElementById("screen_placeholder");
        if (placeholder) placeholder.classList.add("is-hidden");

        // Some initial states emit an early empty GL frame while the VGA canvas
        // is still changing size. Do not leave that 300x150 bootstrap canvas on
        // top of the Windows desktop; the next real GL frame will show it again.
        requestAnimationFrame(function() {
            syncGLCanvasPosition();
            if (v86gl && typeof v86gl.hideOverlayCanvas === "function") {
                v86gl.hideOverlayCanvas();
            }
        });
    });

    window.addEventListener("resize", function() {
        requestAnimationFrame(syncGLCanvasPosition);
    });
}

// Game launcher function
function launchGame(gameId) {
    const game = GAMES[gameId];
    if (!game) {
        updateStatus("Game not found!");
        return;
    }
    
    updateStatus("Starting " + game.name + "...");
    startEmulator9x(gameId);
}

// Game launcher function
function launchGameMultiDisk(gameId) {
    const game = GAMES[gameId];
    if (!game) {
        updateStatus("Game not found!");
        return;
    }
    
    updateStatus("Starting " + game.name + "...");
    startEmulator9xMultiDisk(gameId);
}

// Initialize on page load
window.onload = function() {
    const gameId = new URLSearchParams(window.location.search).get("id");
    const selectedGame = GAMES[gameId];
    if (!selectedGame) {
        document.getElementById("game_title").textContent = "Game not found";
        document.getElementById("game_meta").textContent = "Return to the library and choose a game.";
        document.querySelector(".emulator-panel").classList.add("hidden");
        return;
    }
    populateGamePage(gameId, selectedGame);
    renderGamesList();
    updateStatus("Preparing " + selectedGame.name + "…");
    
    // Setup save state button
    document.getElementById("save_state").onclick = async function() {
        if (!emulator) {
            updateStatus("Emulator not running!");
            return;
        }
        if (stateOperationInProgress) {
            updateStatus("Another state operation is already running");
            return;
        }

        const button = this;
        const activeEmulator = emulator;
        const activeBridge = v86gl;
        const wasRunning = activeEmulator.is_running();
        stateOperationInProgress = true;
        button.disabled = true;
        updateStatus("Saving state...");
        try {
            if (wasRunning) {
                await activeEmulator.stop();
            }
            if (activeBridge && typeof activeBridge.prepareSaveState === "function") {
                const glState = activeBridge.prepareSaveState();
                const glMiB = (glState.bytes / 1024 / 1024).toFixed(1);
                updateStatus("Saving state (OpenGL checkpoint " + glMiB + " MiB)...");
            }

            const state_data = await activeEmulator.save_state();
            var blob = new Blob([state_data], { type: "application/octet-stream" });
            var url = window.URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = gameId + "_v86_state.bin";
            a.click();
            window.URL.revokeObjectURL(url);
            updateStatus("State saved to your Downloads folder");
        } catch (err) {
            console.error("Failed to save emulator state:", err);
            updateStatus("Save Failed: " + (err && err.message || err));
        } finally {
            button.disabled = false;
            if (wasRunning && emulator === activeEmulator) {
                try {
                    await activeEmulator.run();
                } catch (err) {
                    console.error("Failed to resume emulator after save:", err);
                }
            }
            stateOperationInProgress = false;
        }
    };

    // Setup load state button
    document.getElementById("load_state_btn").onclick = function() {
        document.getElementById("load_state_file").click();
    };

    document.getElementById("load_state_file").onchange = async function(e) {
        var file = e.target.files[0];
        if (!file || !emulator) return;
        if (stateOperationInProgress) {
            this.value = "";
            updateStatus("Another state operation is already running");
            return;
        }

        const input = this;
        const activeEmulator = emulator;
        const activeBridge = v86gl;
        const wasRunning = activeEmulator.is_running();
        let bridgeRestorePending = false;
        let restoreCompleted = false;
        stateOperationInProgress = true;
        updateStatus("Restoring state...");
        try {
            const stateData = await file.arrayBuffer();
            if (wasRunning) {
                await activeEmulator.stop();
            }
            if (activeBridge && typeof activeBridge.beginStateRestore === "function") {
                activeBridge.beginStateRestore();
                bridgeRestorePending = true;
            }

            await activeEmulator.restore_state(stateData);
            if (activeBridge && typeof activeBridge.finishStateRestore === "function") {
                await activeBridge.finishStateRestore();
                bridgeRestorePending = false;
            }
            restoreCompleted = true;

            if (emulator !== activeEmulator) {
                throw new Error("The active emulator changed during state restore");
            }

            if (wasRunning) {
                await activeEmulator.run();
            }

            updateStatus("State Restored!");
        } catch (err) {
            if (bridgeRestorePending && activeBridge &&
                typeof activeBridge.cancelStateRestore === "function") {
                activeBridge.cancelStateRestore();
            }
            console.error("Failed to restore emulator state:", err);
            updateStatus((restoreCompleted ? "State restored, but resume failed: " : "Restore Failed: ") +
                (err && err.message || err));
            // A partially restored VM must stay paused; running it with an
            // incomplete WebGL reconstruction would recreate the corruption.
        } finally {
            stateOperationInProgress = false;
            input.value = "";
        }
    };

    // Setup insert CD button
    document.getElementById("insert_cd_btn").onclick = function() {
        document.getElementById("insert_cd_file").click();
    };

    document.getElementById("insert_cd_file").onchange = function(e) {
        var file = e.target.files[0];
        if (!file || !emulator) return;

        updateStatus("Loading CD image...");

        var reader = new FileReader();
        reader.onerror = function() {
            console.error("Failed to read CD file");
            updateStatus("Swap Failed: Read Error");
        };
        reader.onload = function(ev) {
            var arrayBuffer = ev.target.result;
            updateStatus("Inserting CD...");
            emulator.set_cdrom({
                buffer: arrayBuffer,
                async: true
            }).then(function() {
                updateStatus("CD Inserted! Check My Computer.");
                console.log("Successfully swapped to:", file.name);
            }).catch(function(err) {
                console.error("Swap error:", err);
                updateStatus("Swap Failed: Check Console");
            });
        };
        reader.readAsArrayBuffer(file);
    };

    // Setup eject CD button
    document.getElementById("eject_cd_btn").onclick = function() {
        if (!emulator) {
            updateStatus("The emulator is still starting");
            return;
        }
        emulator.eject_cdrom();
        updateStatus("CD ejected");
    };

    // Setup fullscreen button
    document.getElementById("fullscreen_btn").onclick = function() {
        var container = document.getElementById("screen_container");
        if (!document.fullscreenElement) {
            container.requestFullscreen().catch(function(err) {
                console.error("Fullscreen request failed:", err);
                updateStatus("Fullscreen not supported");
            });
        } else {
            document.exitFullscreen();
        }
    };

    // Update fullscreen button text when fullscreen changes
    document.addEventListener("fullscreenchange", function() {
        var btn = document.getElementById("fullscreen_btn");
        var label = btn.querySelector("span:last-child");
        if (document.fullscreenElement) {
            if (label) label.textContent = "Exit full screen";
        } else {
            if (label) label.textContent = "Full screen";
        }
    });

    // Setup mouse lock
    var canvas = document.querySelector("#screen_container canvas");
    if (canvas) {
        canvas.addEventListener("mousedown", function() {
            canvas.requestPointerLock();
        });
    }

    // preview=1 keeps visual QA from downloading multi-gigabyte game disks.
    if (new URLSearchParams(window.location.search).get("preview") === "1") {
        updateStatus("Preview mode — emulator download paused");
    } else {
        launchGameMultiDisk(gameId);
    }
};

function updateStatus(text) {
    document.getElementById("status_text").innerText = text;
}
