import {execFileSync} from 'node:child_process';
import {mkdtemp,cp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {account,assertDestination,assertAccount,verifyOwner} from './publish-target.mjs';

// Uses a disposable checkout; the source checkout and its branch are untouched.
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const git=(args,cwd=root)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim();
const remote=git(['remote','get-url','origin']);
assertDestination(remote);
await verifyOwner();
// Ask the normal credential helper for this specific account. Keep credentials
// only in memory, never in command arguments, files, or console output.
let credentialText;
try {
  credentialText=execFileSync('git',['credential','fill'],{cwd:root,input:`protocol=https\nhost=github.com\nusername=${account}\n\n`,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'},stdio:['pipe','pipe','pipe']});
} catch { throw Error(`Sign in to GitHub as ${account} before publishing.`); }
const credentials=Object.fromEntries(credentialText.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
credentialText='';
const identity=await fetch('https://api.github.com/user',{headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${credentials.password}`}});
credentials.password='';
assertAccount((await identity.json()).login);
execFileSync(process.execPath,['--test',...(await readdir(join(root,'test'))).filter(name=>name.endsWith('.test.mjs')).map(name=>`test/${name}`)],{cwd:root,stdio:'inherit'});
await import('./build-static.mjs');
const temp=await mkdtemp(join(tmpdir(),'redline-publish-'));
try {
  git(['init','-b','gh-pages'],temp);
  git(['config','user.name',git(['config','user.name'])],temp);
  git(['config','user.email',git(['config','user.email'])],temp);
  git(['remote','add','origin',remote],temp);
  git(['config','credential.https://github.com.username',account],temp);
  const existing=git(['ls-remote','--heads','origin','gh-pages'],temp);
  if(existing){git(['fetch','--depth=1','origin','gh-pages'],temp);git(['checkout','-B','gh-pages','FETCH_HEAD'],temp);}
  for(const entry of await readdir(temp))if(entry!=='.git')await rm(join(temp,entry),{recursive:true,force:true});
  await cp(join(root,'dist'),temp,{recursive:true});
  git(['add','-A'],temp);
  if(git(['status','--porcelain'],temp)){
    git(['commit','-m',`Publish Redline ${git(['rev-parse','--short','HEAD'])}`],temp);
    git(['push','origin','gh-pages'],temp);
  }
  console.log('Published build pushed to gh-pages. GitHub Pages will serve it after its build finishes.');
} finally { await rm(temp,{recursive:true,force:true}); }
