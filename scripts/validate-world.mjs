// Validate the bundled geography without relying on an earlier repository history.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context={window:{}};vm.createContext(context);
vm.runInContext(readFileSync('public/world.js','utf8'),context);
const world=context.window;
assert.equal(world.WORLD_PATHS.length,176);assert.equal(world.REGION_PATHS.length,581);
assert.equal(world.ANTARCTICA_POLYGONS.length,8);
for(const path of [...world.WORLD_PATHS,...world.REGION_PATHS])assert.ok(!/NaN|Infinity/.test(path));
for(const city of world.MAP_CITIES)assert.ok(Number.isFinite(city.longitude)&&Number.isFinite(city.latitude));
console.log('Bundled world geography and city index are valid.');
