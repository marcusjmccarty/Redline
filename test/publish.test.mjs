import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertDestination,assertAccount,verifyOwner,assertSourcePublished,assertCommitted,pushBuild,privateFiles,shipped} from '../scripts/publish-target.mjs';

const gitIn=cwd=>(args,at=cwd)=>execFileSync('git',args,{cwd:at,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}}).trim();
// A throwaway origin and clone, so these checks run real git without any network.
async function source(t){
  const base=await mkdtemp(join(tmpdir(),'redline-publish-test-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const origin=join(base,'origin.git'),clone=join(base,'clone'),git=gitIn(clone);
  await mkdir(clone);gitIn(base)(['init','--bare','-b','main',origin]);
  git(['init','-b','main']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);git(['remote','add','origin',origin]);
  await mkdir(join(clone,'public'));
  await writeFile(join(clone,'.gitignore'),'.DS_Store\n*.redline\n.env*\n');await writeFile(join(clone,'public/app.js'),'one\n');
  git(['add','-A']);git(['commit','-m','first']);git(['push','origin','main']);
  return {base,origin,clone,git};
}

test('publication rejects the wrong account, destination, and redirected owner',async()=>{
  assertDestination('https://github.com/marcusjmccarty/Redline.git');
  assertAccount('marcusjmccarty');
  assert.throws(()=>assertDestination('https://github.com/mmccarty-byte/Redline.git'));
  assert.throws(()=>assertDestination('https://github.com/marcusjmccarty/Other.git'));
  assert.throws(()=>assertAccount('mmccarty-byte'));
  assert.throws(()=>assertAccount(undefined));
  await assert.rejects(verifyOwner(async()=>new Response(null,{status:404})));
  await assert.rejects(verifyOwner(async()=>Response.json({full_name:'mmccarty-byte/Redline'})));
  await verifyOwner(async()=>Response.json({full_name:'marcusjmccarty/Redline'}));
});

test('publishing refuses a dirty tree, a HEAD that differs from origin/main, and ignored private files',async t=>{
  const {base,origin,clone,git}=await source(t);
  assertSourcePublished(git);
  await writeFile(join(clone,'public/app.js'),'edited\n');
  assert.throws(()=>assertSourcePublished(git),/Commit or remove local changes/,'An edited file');
  git(['checkout','--','public/app.js']);
  await writeFile(join(clone,'public/atlas-new.js'),'work in progress\n');
  assert.throws(()=>assertSourcePublished(git),/Commit or remove local changes/,'An untracked file under public/');
  await rm(join(clone,'public/atlas-new.js'));
  await writeFile(join(clone,'public/app.js'),'two\n');git(['add','-A']);git(['commit','-m','local only']);
  assert.throws(()=>assertSourcePublished(git),/HEAD must equal origin\/main/,'A commit not pushed yet');
  git(['push','origin','main']);assertSourcePublished(git);
  // Another clone pushes newer work, so this checkout is now a stale one that would roll the site back.
  const other=join(base,'other');gitIn(base)(['clone','-b','main',origin,other]);const elsewhere=gitIn(other);
  elsewhere(['config','user.name','Test']);elsewhere(['config','user.email','test@example.invalid']);
  await writeFile(join(other,'public/app.js'),'three\n');elsewhere(['add','-A']);elsewhere(['commit','-m','newer']);elsewhere(['push','origin','main']);
  assert.throws(()=>assertSourcePublished(git),/HEAD must equal origin\/main/,'Behind origin/main');
  git(['pull','--ff-only','origin','main']);assertSourcePublished(git);
  await writeFile(join(clone,'public/My summér.redline'),'private');
  assert.throws(()=>assertSourcePublished(git),/My summér\.redline/,'Ignored backups look clean to git status');
  await rm(join(clone,'public/My summér.redline'));
  await writeFile(join(clone,'public/.env.local'),'SECRET=1');
  assert.throws(()=>assertSourcePublished(git),/\.env\.local/);
  await rm(join(clone,'public/.env.local'));
  await writeFile(join(clone,'public/.DS_Store'),'finder');assertSourcePublished(git);
  assertCommitted(git);await writeFile(join(clone,'public/app.js'),'rewritten by the build\n');
  assert.throws(()=>assertCommitted(git),/including any the build just rewrote/);
});

test('publishing reports a push only when one happened, and refuses private files at the last step',async t=>{
  const {base,origin}=await source(t),temp=join(base,'pages'),git=gitIn(temp);
  await mkdir(temp);git(['init','-b','gh-pages']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);git(['remote','add','origin',origin]);
  const live=()=>{try{return gitIn(base)(['--git-dir',origin,'rev-parse','gh-pages']);}catch{return '';}};
  await writeFile(join(temp,'index.html'),'site\n');
  assert.equal(pushBuild(git,temp,'Publish one'),true);const pushed=live();assert.ok(pushed);assert.equal(pushed,git(['rev-parse','HEAD']));
  assert.equal(pushBuild(git,temp,'Publish again'),false,'An identical build reports that nothing was pushed');
  assert.equal(live(),pushed);
  await writeFile(join(temp,'My trip.redline'),'private');
  assert.throws(()=>pushBuild(git,temp,'Publish leak'),/My trip\.redline/);assert.equal(live(),pushed,'Nothing reached the remote');
  await rm(join(temp,'My trip.redline'));git(['reset','-q']);
  await writeFile(join(temp,'index.html'),'changed\n');
  assert.equal(pushBuild(git,temp,'Publish two'),true);assert.notEqual(live(),pushed);
});

test('the build keeps backups and clutter out of the site, and stops on stray private files',async t=>{
  const base=await mkdtemp(join(tmpdir(),'redline-build-test-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const from=join(base,'public'),to=join(base,'dist');await mkdir(join(from,'nested'),{recursive:true});
  for(const name of ['app.js','world.js','.DS_Store','My summer.redline','nested/.DS_Store','nested/Old trip.redline','nested/keep.css'])await writeFile(join(from,name),'x');
  await cp(from,to,{recursive:true,filter:shipped});
  assert.deepEqual((await readdir(to,{recursive:true})).sort(),['app.js','nested','nested/keep.css']);
  assert.deepEqual(privateFiles(['app.js','atlas/land.jpg','relief/16-3-2.webp','relief/index.js','My trip.redline','IMG_0042.JPG','nested/photo.heic','photo.jpeg','atlas/hidden.redline']),['My trip.redline','IMG_0042.JPG','nested/photo.heic','photo.jpeg','atlas/hidden.redline']);
  const strays=['atlas/me-at-the-beach.jpg','relief/holiday.webp','snap.png','snap.webp','clip.MOV','scan.pdf','stops.csv','raw.dng','backup.zip'];
  assert.deepEqual(privateFiles(strays),strays,'Only the map’s own pictures may ship');
  const build=await readFile(new URL('../scripts/build-static.mjs',import.meta.url),'utf8');
  assert.match(build,/filter:shipped/,'The real build uses this filter');assert.ok(build.indexOf('privateFiles(')<build.indexOf('await cp('),'and stops before copying anything');
  assert.deepEqual(privateFiles(await readdir(new URL('../public/',import.meta.url),{recursive:true})),[],'The app itself carries nothing that would stop its own build');
});

test('publish.mjs runs its source checks before any credential is touched, and after the build',async()=>{
  const script=await readFile(new URL('../scripts/publish.mjs',import.meta.url),'utf8');
  const at=text=>{const index=script.indexOf(text);assert.ok(index>=0,text);return index;};
  assert.ok(at('await verifyOwner()')<at('assertSourcePublished(git)'));assert.ok(at('assertSourcePublished(git)')<at("'credential','fill'"));
  assert.ok(at("import('./build-static.mjs')")<at('assertCommitted(git)'));assert.ok(at('assertCommitted(git)')<at('pushBuild(git,temp'));
  assert.doesNotMatch(script,/'push'/,'The only push is the one that reports itself');
});
