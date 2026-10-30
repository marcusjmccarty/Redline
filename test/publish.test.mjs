import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDestination,assertAccount,verifyOwner} from '../scripts/publish-target.mjs';

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
