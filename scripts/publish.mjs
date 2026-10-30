import {execFileSync} from 'node:child_process';
import {mkdtemp,cp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

// Uses a disposable checkout; the source checkout and its branch are untouched.
const root=resolve(new URL('../',import.meta.url).pathname);
const git=(args,cwd=root)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim();
const remote=git(['remote','get-url','origin']);
execFileSync(process.execPath,['--test','test/storage.test.mjs','test/trace.test.mjs'],{cwd:root,stdio:'inherit'});
await import('./build-static.mjs');
const temp=await mkdtemp(join(tmpdir(),'redline-publish-'));
try {
  git(['init','-b','gh-pages'],temp);
  git(['config','user.name',git(['config','user.name'])],temp);
  git(['config','user.email',git(['config','user.email'])],temp);
  git(['remote','add','origin',remote],temp);
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
