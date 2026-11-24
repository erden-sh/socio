// The Locals' preview page (scripts/locals/preview.mjs): one big rig with
// character and state buttons, then every Local in every state, live, and at
// the sizes the app shows them.
import { characters } from '../../packages/client/src/locals/characters';
import { RIG_STATES, Rig, run, scopeIds, type CharacterRig, type RigState } from '../../packages/client/src/locals/rig';

const cast: CharacterRig[] = Object.values(characters);
let n = 0;
let stopHero = () => {};
function mount(host: HTMLElement, character: CharacterRig, state: RigState) {
    host.innerHTML = scopeIds(character.svg, `p${n++}-`);
    const rig = new Rig(character, host.querySelector('svg')!, n * 37);
    rig.setState(state);
    return { rig, stop: run(rig) };
}

const big = document.getElementById('big')!;
const buttons = document.getElementById('buttons')!;
let heroCharacter = cast[0];
let heroState: RigState = 'idle';
let hero = mount(big, heroCharacter, heroState);
stopHero = hero.stop;
const row = (cls: string) => {
    const d = document.createElement('div');
    d.className = cls;
    buttons.appendChild(d);
    return d;
};
const who = row('row');
const what = row('row');
const pick = (parent: HTMLElement, label: string, on: boolean, click: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('on', on);
    b.onclick = () => {
        parent.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        click();
    };
    parent.appendChild(b);
};
for (const c of cast) {
    pick(who, c.name, c === heroCharacter, () => {
        heroCharacter = c;
        stopHero();
        hero = mount(big, heroCharacter, heroState);
        stopHero = hero.stop;
    });
}
for (const s of RIG_STATES) {
    pick(what, s, s === heroState, () => {
        heroState = s;
        hero.rig.setState(s);
    });
}

const strip = document.getElementById('strip')!;
const sizes = document.getElementById('sizes')!;
for (const character of cast) {
    const h = document.createElement('h3');
    h.textContent = character.name;
    strip.appendChild(h);
    for (const s of RIG_STATES) {
        const cell = document.createElement('figure');
        cell.innerHTML = `<div class="av"></div><figcaption>${s}</figcaption>`;
        strip.appendChild(cell);
        mount(cell.querySelector('.av')!, character, s);
    }
    const line = document.createElement('div');
    line.className = 'row';
    sizes.appendChild(line);
    for (const px of [20, 36, 54, 96]) {
        const d = document.createElement('div');
        d.style.width = d.style.height = `${px}px`;
        line.appendChild(d);
        mount(d, character, px < 40 ? 'working' : 'idle');
    }
}
