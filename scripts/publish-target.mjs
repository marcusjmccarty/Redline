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
