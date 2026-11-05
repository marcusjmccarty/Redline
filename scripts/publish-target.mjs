export const repository = 'marcusjmccarty/Redline';
export const account = 'marcusjmccarty';

export function assertDestination(remote) {
  if (remote !== `https://github.com/${repository}.git` && remote !== `https://github.com/${repository}`) {
    throw Error(`Publication is restricted to https://github.com/${repository}.git. Correct origin before publishing.`);
  }
}

export function assertAccount(login) {
  if (login !== account) throw Error(`Sign in to GitHub as ${account} before publishing. A different account must not be used.`);
}

export async function verifyOwner(fetcher=fetch) {
  const response=await fetcher(`https://api.github.com/repos/${repository}`,{headers:{Accept:'application/vnd.github+json'}});
  if (!response.ok) throw Error(`The destination repository is not available yet. Complete its transfer to ${account} before publishing.`);
  const data=await response.json();
  if (data.full_name?.toLowerCase()!==repository.toLowerCase()) throw Error('The repository owner does not match the authorized destination.');
}

// Everything under public/ reaches the public site, so a stray backup, photo, video or document stops the build rather than shipping.
// The only pictures that belong there are the map's own plates and relief tiles.
const personal=/\.(?:jpe?g|hei[cf]|png|gif|tiff?|webp|bmp|avif|dng|cr[23]|nef|arw|raw|mov|mp4|m4v|avi|webm|pdf|csv|zip)$/i;
const mapPicture=/^(?:atlas[\\/](?:land|land-small|sea)\.jpg|relief[\\/]\d+-\d+-\d+\.webp)$/;
export const privateFiles = paths => paths.filter(path => /\.redline$/i.test(path) || personal.test(path) && !mapPicture.test(path));
// Source data and system clutter stay out of the published site.
export const shipped = path => !/(?:\.redline|\.DS_Store|[\\/]world\.js)$/.test(path);

const names = text => text.split('\0').filter(Boolean);

// The live site is exactly origin/main: never a stale clone, and never uncommitted work under a clean-looking message.
export function assertSourcePublished(git) {
  git(['fetch','origin','+refs/heads/main:refs/remotes/origin/main']);
  assertCommitted(git);
  if (git(['rev-parse','HEAD']) !== git(['rev-parse','origin/main'])) throw Error('HEAD must equal origin/main before publishing. Push your commits or pull the latest first.');
  // Ignored files look clean to git status yet would be copied into the build. Finder's .DS_Store is the build filter's to drop.
  const ignored = names(git(['ls-files','-z','--others','--ignored','--exclude-standard','public'])).filter(path => !/(?:^|\/)\.DS_Store$/.test(path));
  if (ignored.length) throw Error(`Move these ignored files out of public/ before publishing: ${ignored.join(', ')}`);
}
export function assertCommitted(git) {
  if (git(['status','--porcelain'])) throw Error('Commit or remove local changes before publishing, including any the build just rewrote.');
}

// Stages the build in the disposable checkout and pushes it. Returns whether a push happened.
export function pushBuild(git, cwd, message) {
  git(['add','-A'],cwd);
  const banned = names(git(['ls-files','-z'],cwd)).filter(path => /(?:\.redline|\.DS_Store)$/i.test(path));
  if (banned.length) throw Error(`Refusing to publish private or stray files: ${banned.join(', ')}`);
  if (!git(['status','--porcelain'],cwd)) return false;
  git(['commit','-m',message],cwd);
  git(['push','origin','gh-pages'],cwd);
  return true;
}
