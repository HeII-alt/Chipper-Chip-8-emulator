import { roms } from "./roms.js";
const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");

const WIDTH = 64;
const HEIGHT = 32;
const SCALE = 10;

const pixels = new Array(WIDTH * HEIGHT).fill(0);
const memory = new Uint8Array(4096);

let pc = 0x200;
const V = new Uint8Array(16);
let I = 0;
let delayTimer = 0;
let soundTimer = 0;
const stack = [];
let waitingKey = -1;
let vblank = true;

const font = [
    0xF0, 0x90, 0x90, 0x90, 0xF0, 0x20, 0x60, 0x20, 0x20, 0x70,
    0xF0, 0x10, 0xF0, 0x80, 0xF0, 0xF0, 0x10, 0xF0, 0x10, 0xF0,
    0x90, 0x90, 0xF0, 0x10, 0x10, 0xF0, 0x80, 0xF0, 0x10, 0xF0,
    0xF0, 0x80, 0xF0, 0x90, 0xF0, 0xF0, 0x10, 0x20, 0x40, 0x40,
    0xF0, 0x90, 0xF0, 0x90, 0xF0, 0xF0, 0x90, 0xF0, 0x10, 0xF0,
    0xF0, 0x90, 0xF0, 0x90, 0x90, 0xE0, 0x90, 0xE0, 0x90, 0xE0,
    0xF0, 0x80, 0x80, 0x80, 0xF0, 0xE0, 0x90, 0x90, 0x90, 0xE0,
    0xF0, 0x80, 0xF0, 0x80, 0xF0, 0xF0, 0x80, 0xF0, 0x80, 0x80
];
memory.set(font, 0x050);

// ---------- keyboard ----------
const keys = new Array(16).fill(false);

const keyMap = {
    Digit1: 0x1, Digit2: 0x2, Digit3: 0x3, Digit4: 0xC,
    KeyQ: 0x4,   KeyW: 0x5,   KeyE: 0x6,   KeyR: 0xD,
    KeyA: 0x7,   KeyS: 0x8,   KeyD: 0x9,   KeyF: 0xE,
    KeyZ: 0xA,   KeyX: 0x0,   KeyC: 0xB,   KeyV: 0xF
};

const releaseTimers = new Array(16).fill(null);
const pressTime = new Array(16).fill(0);
const MIN_HOLD = 150; // milliseconds

document.addEventListener("keydown", (event) => {
    const key = keyMap[event.code];
    if (key === undefined) return;

    if (releaseTimers[key] !== null) {
        clearTimeout(releaseTimers[key]);
        releaseTimers[key] = null;
    }
    if (!keys[key]) pressTime[key] = performance.now();
    keys[key] = true;
});

document.addEventListener("keyup", (event) => {
    const key = keyMap[event.code];
    if (key === undefined) return;

    const held = performance.now() - pressTime[key];
    const wait = Math.max(0, MIN_HOLD - held);

    releaseTimers[key] = setTimeout(() => {
        keys[key] = false;
        releaseTimers[key] = null;
    }, wait);
});

// ---------- sound ----------
let audioCtx = null;
let oscillator = null;

function unlockAudio() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
}
document.addEventListener("keydown", unlockAudio);
document.addEventListener("click", unlockAudio);

function startBeep() {
    if (!audioCtx || oscillator) return;
    oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.05;
    oscillator.type = "square";
    oscillator.frequency.value = 440;
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
}
function stopBeep() {
    if (!oscillator) return;
    oscillator.stop();
    oscillator = null;
}

// ---------- drawing ----------
function draw() {
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 640, 320);

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            if (pixels[y * WIDTH + x] === 1) {
                ctx.fillStyle = "white";
                ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
            }
        }
    }
}

// ---------- cpu ----------
function step() {
    const opcode = (memory[pc] << 8) | memory[pc + 1];
    pc += 2;

    const x = (opcode >> 8) & 0xF;
    const y = (opcode >> 4) & 0xF;
    const n = opcode & 0xF;
    const nn = opcode & 0xFF;
    const nnn = opcode & 0xFFF;

    switch (opcode >> 12) {
        case 0x0:
            if (opcode === 0x00E0) {
                pixels.fill(0);
            } else if (opcode === 0x00EE) {
                pc = stack.pop();
            }
            break;
        case 0x1:
            pc = nnn;
            break;
        case 0x2:
            stack.push(pc);
            pc = nnn;
            break;
        case 0x3:
            if (V[x] === nn) pc += 2;
            break;
        case 0x4:
            if (V[x] !== nn) pc += 2;
            break;
        case 0x5:
            if (V[x] === V[y]) pc += 2;
            break;
        case 0x6:
            V[x] = nn;
            break;
        case 0x7:
            V[x] = V[x] + nn;
            break;
        case 0x8: {
            const vx = V[x];
            const vy = V[y];

            switch (n) {
                case 0x0: V[x] = vy; break;
                case 0x1: V[x] = vx | vy; V[0xF] = 0; break;
                case 0x2: V[x] = vx & vy; V[0xF] = 0; break;
                case 0x3: V[x] = vx ^ vy; V[0xF] = 0; break;
                case 0x4:
                    V[x] = vx + vy;
                    V[0xF] = (vx + vy) > 255 ? 1 : 0;
                    break;
                case 0x5:
                    V[x] = vx - vy;
                    V[0xF] = vx >= vy ? 1 : 0;
                    break;
                case 0x6:
                    V[x] = vy >> 1;
                    V[0xF] = vy & 1;
                    break;
                case 0x7:
                    V[x] = vy - vx;
                    V[0xF] = vy >= vx ? 1 : 0;
                    break;
                case 0xE:
                    V[x] = vy << 1;
                    V[0xF] = (vy >> 7) & 1;
                    break;
            }
            break;
        }
        case 0x9:
            if (V[x] !== V[y]) pc += 2;
            break;
        case 0xA:
            I = nnn;
            break;
        case 0xB:
            pc = nnn + V[0];
            break;
        case 0xC:
            V[x] = Math.floor(Math.random() * 256) & nn;
            break;
        case 0xD: {
            if (!vblank){
                pc -= 2;
                break;
            }
            vblank = false;

            const px = V[x] % WIDTH;
            const py = V[y] % HEIGHT;
            V[0xF] = 0;

            for (let row = 0; row < n; row++) {
                if (py + row >= HEIGHT) break;
                const spriteByte = memory[I + row];

                for (let col = 0; col < 8; col++) {
                    if (px + col >= WIDTH) break;

                    if (spriteByte & (0x80 >> col)) {
                        const index = (py + row) * WIDTH + (px + col);
                        if (pixels[index] === 1) {
                            V[0xF] = 1;
                        }
                        pixels[index] ^= 1;
                    }
                }
            }
            break;
        }
        case 0xE:
            if (nn === 0x9E) {
                if (keys[V[x] & 0xF]) pc += 2;
            } else if (nn === 0xA1) {
                if (!keys[V[x] & 0xF]) pc += 2;
            }
            break;
        case 0xF: {
            switch (nn) {
                case 0x07:
                    V[x] = delayTimer;
                    break;
                case 0x0A: {
                    if (waitingKey === -1) {
                        waitingKey = keys.indexOf(true);
                    }
                    if (waitingKey === -1 || keys[waitingKey]) {
                        pc -= 2;
                    } else {
                        V[x] = waitingKey;
                        waitingKey = -1;
                    }
                    break;
                }
                case 0x15:
                    delayTimer = V[x];
                    break;
                case 0x18:
                    soundTimer = V[x];
                    break;
                case 0x1E:
                    I = I + V[x];
                    break;
                case 0x29:
                    I = 0x050 + (V[x] & 0xF) * 5;
                    break;
                case 0x33:
                    memory[I] = Math.floor(V[x] / 100);
                    memory[I + 1] = Math.floor(V[x] / 10) % 10;
                    memory[I + 2] = V[x] % 10;
                    break;
                case 0x55:
                    for (let i = 0; i <= x; i++) {
                        memory[I + i] = V[i];
                    }
                    I = I + x + 1;
                    break;
                case 0x65:
                    for (let i = 0; i <= x; i++) {
                        V[i] = memory[I + i];
                    }
                    I = I + x + 1;
                    break;
            }
            break;
        }
        default:
            console.log("not done yet:", opcode.toString(16));
    }
}

// ---------- main loop ----------
let paused = true;
let userPaused = false;
function frame() {
    vblank = true;

    if(!paused && !userPaused) {
     for (let i = 0; i < 20; i++) {
            step();
        }
    if (delayTimer > 0) delayTimer--;
    if (soundTimer > 0) soundTimer--;
    }

    if (soundTimer > 0 && !paused && !userPaused) startBeep();
    else stopBeep();

    draw();
    requestAnimationFrame(frame);
}

async function loadROM(url) {
    const response = await fetch(url);

    if (!response.ok) {
        document.title = "ROM not found: " + url;
        throw new Error("Could not load " + url + " (" + response.status + ")");
    }

    document.title = "CHIP-8";
    const buffer = await response.arrayBuffer();
    const rom = new Uint8Array(buffer);

    for (let i = 0; i < rom.length; i++) {
        memory[0x200 + i] = rom[i];
    }
}



function reset() {
    memory.fill(0);
    memory.set(font, 0x050);
    pixels.fill(0);
    V.fill(0);
    stack.length = 0;
    pc = 0x200;
    I = 0;
    delayTimer = 0;
    soundTimer = 0;
    waitingKey = -1;
}

const carts = document.querySelectorAll(".cart");

carts.forEach((cart) => {
    cart.addEventListener("click", () => {
        carts.forEach((c) => c.classList.remove("selected"));
        cart.classList.add("selected");
        cart.blur();
        romSelect.value = "";
        startGame(cart.dataset.rom);
    });
});

async function startGame(url) {
    userPaused = false;
    pauseBtn.classList.remove("off");
    paused = true;
    reset();
    await loadROM(url);
    paused = false;
}

const pauseBtn = document.getElementById("pauseBtn");

pauseBtn.addEventListener("click", () => {
    userPaused = !userPaused;
    pauseBtn.classList.toggle("off", userPaused);
    pauseBtn.blur();
});

const romSelect = document.getElementById("romSelect");

roms.forEach((rom) => {
    const option = document.createElement("option");
    option.value = rom.file;
    option.textContent = rom.name;
    romSelect.appendChild(option);
});

romSelect.addEventListener("change", () => {
    if (romSelect.value === "") return;
    carts.forEach((c) => c.classList.remove("selected"));
    startGame(romSelect.value);
    romSelect.blur() 
});

frame();