import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={};vm.createContext(context);
vm.runInContext(readFileSync(new URL('../public/labels.js',import.meta.url),'utf8'),context);
const {place,estimate,overlaps,slots,crosses,indexLines,projectIndex,occupancy}=context.RedlineLabels;

const item=(id,x,y,priority)=>({id,x,y,width:estimate(id),height:14,priority});
const dot=({x,y})=>({x:x-4.5,y:y-4.5,w:9,h:9});
function assertClear(items,result,{width,height,obstacles=[]}){
  result.forEach((slot,i)=>{
    if(!slot)return;
    const {box}=slot;
    assert.ok(box.x>=0&&box.y>=0&&box.x+box.w<=width&&box.y+box.h<=height,`${items[i].id} stays in the viewport`);
    for(const obstacle of obstacles)assert.ok(!overlaps(box,obstacle),`${items[i].id} avoids obstacles`);
    items.forEach((other,j)=>{
      if(j===i)return;
      assert.ok(!overlaps(box,dot(other)),`${items[i].id} does not cover ${other.id}`);
      if(result[j])assert.ok(!overlaps(box,result[j].box),`${items[i].id} and ${other.id} do not overlap`);
    });
  });
}

test('an isolated city keeps the original right-above label',()=>{
  const [slot]=place([item('LISBON',400,300,0)],{width:1440,height:900});
  assert.equal(slot.name,'right-above');assert.equal(slot.x,10);assert.equal(slot.y,-12);assert.equal(slot.anchor,'start');
  assert.equal(new Set(slots.map(slot=>slot.name)).size,slots.length);
});

test('two close cities both get non-overlapping placements',()=>{
  const view={width:1440,height:900};
  for(const pair of [[item('VIENNA',785,209,0),item('BUDAPEST',796,215,1)],[item('PUERTO AYORA',398,451,0),item('QUITO',406,451,1)],[item('KUALA LUMPUR',1126,486,0),item('SINGAPORE',1135,495,1)]]){
    const result=place(pair,view);
    assert.ok(result.every(Boolean),`${pair[0].id} and ${pair[1].id} are both labelled`);
    assert.notEqual(result[0].name==='right-above'&&result[1].name==='right-above',true);
    assertClear(pair,result,view);
  }
});

test('a crowded cluster hides lower-priority labels but keeps the active one',()=>{
  const view={width:800,height:600},names=['ROME','NAPLES','FLORENCE','BOLOGNA','VENICE','MILAN','TURIN','GENOA','PISA','SIENA'];
  const items=names.map((name,i)=>item(name,400+(i%4)*7,300+Math.floor(i/4)*6,i));
  items[9].priority=-1;
  const result=place(items,view);
  assert.ok(result[9],'The active stop keeps its label');
  assert.ok(result.some(slot=>slot===null),'Some labels are hidden');
  const hidden=result.map((slot,i)=>slot?null:i).filter(i=>i!==null);
  assert.ok(hidden.every(i=>i!==9));
  assert.ok(result[0],'The first stop in route order is labelled before later ones');
  assertClear(items,result,view);
});

test('labels never leave the viewport and flip away from the edges',()=>{
  const view={width:390,height:640},items=[];
  for(let x=0;x<=390;x+=26)for(let y=0;y<=640;y+=80)items.push(item(`CITY ${items.length}`,x,y,items.length));
  const result=place(items,view);
  assertClear(items,result,view);
  const [right]=place([item('AUCKLAND',380,300,0)],view);
  assert.ok(right.anchor==='end','A city at the right edge is labelled to its left');
  const [top]=place([item('REYKJAVIK',100,8,0)],view);
  assert.ok(top.y>0,'A city at the top edge is labelled below');
  const [none]=place([item('NOWHERE',-50,-50,0)],view);
  assert.equal(none,null);
});

test('obstacles such as the route dock are avoided',()=>{
  const view={width:1000,height:700},dock={x:200,y:560,w:600,h:120};
  const items=[item('CAPE TOWN',500,550,0),item('DURBAN',300,700-150,1)];
  const result=place(items,{...view,obstacles:[dock]});
  assert.ok(result.every(Boolean));assert.ok(result.every(slot=>slot.y<0),'Labels sit above the dock');
  assertClear(items,result,{...view,obstacles:[dock]});
});

test('the previous candidate is kept while it is still valid',()=>{
  const view={width:1440,height:900},items=[item('VIENNA',785,209,0),item('BRATISLAVA',797,209,1)];
  const first=place(items,view);
  assertClear(items,first,view);
  // The camera moves the cities apart: each label keeps its slot even though right-above is free again.
  const apart=[item('VIENNA',700,209,0),item('BRATISLAVA',900,209,1)];
  const previous=new Map(first.map((slot,i)=>[items[i].id,slot.name]));
  const kept=place(apart,{...view,previous});
  assert.deepEqual(kept.map(slot=>slot.name),first.map(slot=>slot.name));
  assert.ok(first.some(slot=>slot.name!=='right-above'),'The pair needed a non-default slot');
  assert.deepEqual(place(apart,view).map(slot=>slot.name),['right-above','right-above'],'Without history both use the default');
  // Plain objects work too, and a previous slot that is no longer free is abandoned.
  const blocked=place([item('VIENNA',785,209,0)],{...view,previous:{VIENNA:'left-above'},obstacles:[{x:700,y:180,w:80,h:40}]});
  assert.notEqual(blocked[0].name,'left-above');
  assert.equal(place([item('VIENNA',785,209,0)],{...view,previous:{VIENNA:'below'}})[0].name,'below');
});


test('Puerto Ayora and Quito stay on the outside of their dots, including with stale placement history',()=>{
  for(const [a,b] of [[344,390],[398,406]]){
    const items=[item('PUERTO AYORA',a,450,0),item('QUITO',b,448,1)];
    const result=place(items,{width:1440,height:900,previous:{'PUERTO AYORA':'right-above',QUITO:'right-below'}});
    assert.equal(result[0].anchor,'end');assert.equal(result[1].anchor,'start');
    assertClear(items,result,{width:1440,height:900});
    assert.ok(result[0].box.x+result[0].box.w<items[0].x,'Puerto Ayora is labelled to its own west');
    assert.ok(result[1].box.x>items[1].x,'Quito is labelled to its own east');
  }
});

test('route clearance follows the line itself, including tangencies and offscreen segments',()=>{
  const rect={x:40,y:70,w:10,h:10},diagonal=[[0,0],[100,100]];
  assert.equal(crosses(diagonal,rect),false,'A large route bounding box must not hide unrelated labels');
  assert.equal(crosses([[0,70],[100,70]],rect),true);
  assert.equal(crosses([[0,65],[100,65]],rect,5),true);
  assert.equal(crosses([[-100,75],[1000,75]],rect),true);
  const segments=Array.from({length:120},(_,i)=>[[Math.sin(i)*1300,Math.cos(i)*900],[Math.sin(i+.2)*1300,Math.cos(i+.2)*900]]);
  const indexed=indexLines(segments,{width:800,height:600});
  for(let x=4;x<700;x+=31)for(let y=4;y<560;y+=47){
    const box={x,y,w:78,h:20};assert.equal(indexed.hits(box,5),segments.some(segment=>crosses(segment,box,5)),'Spatial indexing retains exact intersections');
  }
});

test('nearby city labels clear route strokes and retain their positions as a camera moves',()=>{
  const view={width:1000,height:700},items=[item('PUERTO AYORA',420,350,0),item('QUITO',443,345,1),item('LIMA',453,390,2)];
  const segments=[[[420,350],[443,345]],[[443,345],[620,170]],[[443,345],[453,390]],[[400,330],[570,330]]];
  const result=place(items,{...view,segments});assert.ok(result.every(Boolean));assertClear(items,result,view);
  result.forEach(slot=>assert.ok(segments.every(segment=>!crosses(segment,slot.box,5)),'Names have breathing room around the red line'));
  const moved=items.map(city=>({...city,x:city.x+2,y:city.y+1})),lines=segments.map(segment=>segment.map(([x,y])=>[x+2,y+1]));
  const previous=new Map(result.map((slot,i)=>[items[i].id,slot.name]));
  assert.deepEqual(place(moved,{...view,segments:lines,previous}).map(slot=>slot?.name),result.map(slot=>slot.name));
});


test('a cached map-coordinate route index matches screen-space clearance at every zoom',()=>{
  const segments=Array.from({length:80},(_,i)=>[[100+i*13,120+Math.sin(i/7)*100],[113+i*13,120+Math.sin((i+1)/7)*100]]);
  const indexed=indexLines(segments,{width:1440,height:720}),bounds={left:14,top:22};
  for(const zoom of [1,1.5,3,7,13]){
    const matrix={a:zoom,d:zoom*1.3,e:14-200*(zoom-1),f:22-100*(zoom-1)},projected=projectIndex(indexed,matrix,bounds);
    const screen=segments.map(segment=>segment.map(([x,y])=>[x*matrix.a+matrix.e-bounds.left,y*matrix.d+matrix.f-bounds.top]));
    for(let x=10;x<1000;x+=37)for(let y=10;y<600;y+=43){const box={x,y,w:82,h:20};assert.equal(projected.hits(box,5),screen.some(segment=>crosses(segment,box,5)));}
  }
});

test('indistinguishable pins show the active name and separate into individually labelled stops at city scale',()=>{
  const cities=[item('MANDALAY',400,300,0),item('AMARAPURA',399,301,1),item('MINGUN',398,298,-1)];
  const view={width:960,height:650,clusterDistance:9};
  const overview=place(cities,view);
  assert.deepEqual(Array.from(overview,Boolean),[false,false,true]);
  const local=cities.map(city=>({...city,x:400+(city.x-400)*16,y:300+(city.y-300)*16}));
  const result=place(local,view);
  assert.ok(result.every(Boolean));assertClear(local,result,view);
  result.forEach((slot,i)=>{if(slot.leader)for(const [j,other] of result.entries())if(i!==j)assert.ok(!crosses(slot.leader,other.box));});
});

test('a hub ringed by its own route keeps its name, across a line only when no clear slot is left',()=>{
  const hub={x:400,y:300},spoke=angle=>[[hub.x,hub.y],[hub.x+Math.cos(angle)*600,hub.y+Math.sin(angle)*600]];
  const ring=Array.from({length:24},(_,i)=>spoke(i/24*Math.PI*2));
  const [named]=place([item('LONDON',hub.x,hub.y,0)],{width:1440,height:900,segments:ring});
  assert.ok(named,'Zero times is not once');
  assert.ok(ring.some(line=>crosses(line,named.box,5)),'It had to cross the red line');
  const [clear]=place([item('LONDON',hub.x,hub.y,0)],{width:1440,height:900,segments:ring.slice(0,3)});
  assert.equal(ring.slice(0,3).some(line=>crosses(line,clear.box,5)),false,'With a clear slot it takes that');
  const crowded=place([item('LONDON',hub.x,hub.y,-1),item('PARIS',hub.x+6,hub.y+30,0)],{width:1440,height:900,segments:ring});
  assert.ok(crowded[0],'The active port wins');
  if(crowded[1])assert.equal(overlaps(crowded[0].box,crowded[1].box,5),false,'Names crossing the line still clear each other');
  assert.equal(place([item('LONDON',hub.x,hub.y,0)],{width:1440,height:900,obstacles:[{x:0,y:0,w:1440,h:900}]})[0],null,'A name never goes under the dock to be seen');
});

test('the occupancy grid answers for gaps, owners and anything past the edges, and can be cleared and reused',()=>{
  const grid=occupancy(400,300);
  assert.equal(grid.hits(10,10,20,20),false);
  grid.add({x:100,y:100,w:40,h:20});
  assert.equal(grid.hits(100,100,1,1),true,'Inside');
  assert.equal(grid.hits(141,100,10,10),false,'Beside it');assert.equal(grid.hits(141,100,10,10,2),true,'Beside it, within the gap');
  assert.equal(grid.hits(90,90,5,5),false,'A shared cell is not a collision');
  grid.add({x:-40,y:-40,w:30,h:30});grid.add({x:390,y:290,w:60,h:60});
  assert.equal(grid.hits(-30,-30,5,5),true,'Past the top left');assert.equal(grid.hits(420,320,5,5),true,'Past the bottom right');
  grid.add({x:200,y:200,w:10,h:10},7);
  assert.equal(grid.hits(200,200,5,5,0,7),false,'A name does not collide with its own dot');assert.equal(grid.hits(200,200,5,5,0,8),true,'But another does');
  // A box wide enough to span many cells: the dock.
  grid.add({x:0,y:250,w:400,h:40});for(let x=0;x<400;x+=23)assert.equal(grid.hits(x,260,3,3),true);
  grid.clear();
  for(const [x,y] of [[100,100],[-30,-30],[420,320],[200,200],[50,260]])assert.equal(grid.hits(x,y,5,5),false,'Nothing is left after a clear');
  assert.ok(grid.fits(400,300));assert.equal(grid.fits(401,300),false);
});

test('stop names are placed into the grid they are given, so what is lettered next can keep off them, their dots and their leaders',()=>{
  const grid=occupancy(800,600),items=[item('ALPHA',400,300,0),item('BRAVO',408,306,1),item('CHARLIE',402,312,2),item('DELTA',410,294,3),item('ECHO',396,306,4),item('FOXTROT',405,303,5)];
  const obstacle={x:20,y:20,w:60,h:40},result=place(items,{width:800,height:600,grid,obstacles:[obstacle]});
  assert.ok(grid.hits(40,40,2,2),'The fixtures are in it');
  for(const {x,y} of items)assert.ok(grid.hits(x-1,y-1,2,2),'The dots are');
  result.forEach(slot=>{if(slot)assert.ok(grid.hits(slot.box.x+2,slot.box.y+2,2,2),'The names are');});
  const led=result.find(slot=>slot?.leader);assert.ok(led,'A crowd this close needs a leader somewhere');
  const [[x0,y0],[x1,y1]]=led.leader;assert.ok(grid.hits((x0+x1)/2-2,(y0+y1)/2-2,4,4,2),'The leader is');
});

test('a name stays near its dot while there is any room: a ring only when the near places are gone, and a short leader only with a ring',()=>{
  const view={width:1200,height:800};
  const [alone]=place([item('LONELY',600,400,0)],view);assert.ok(!alone.leader,'Nothing to step around, so no leader');
  // A crowd pushes some out to a ring, each with a leader back to its dot.
  const crowd=[['ALPHA',0,0],['BRAVO',9,6],['CHARLIE',2,12],['DELTA',10,-6],['ECHO',-5,6],['FOXTROT',5,3],['GOLF',-9,-4],['HOTEL',14,12]].map(([name,dx,dy],i)=>item(name,600+dx,400+dy,i)),placed=place(crowd,view);
  for(const slot of place([item('LEFT',600,400,0),item('RIGHT',624,400,1)],view))assert.ok(slots.findIndex(s=>s.name===slot.name)<8,'Two neighbours both stay near');
  const pushed=placed.flatMap((slot,i)=>slot&&slots.findIndex(s=>s.name===slot.name)>=8?[[slot,crowd[i]]]:[]);assert.ok(pushed.length,'Someone is pushed out');
  for(const [slot,city] of pushed)if(Math.hypot(slot.box.x-city.x,slot.box.y-city.y)>30)assert.ok(slot.leader,`${city.id} has a leader`);
  for(const slot of placed)if(slot?.leader)assert.ok(Math.hypot(slot.leader[1][0]-slot.leader[0][0],slot.leader[1][1]-slot.leader[0][1])<70,'A short one');
  const names=slots.map(slot=>slot.name);assert.ok(names.indexOf('right-above')<8&&names.indexOf('left')<8,'The eight near places come first');
  for(const slot of slots.slice(0,8))assert.ok(Math.hypot(slot.x,Math.max(0,Math.abs(slot.y)-(slot.y>0?9:0)))<=22,`${slot.name} is near`);
});

test('a name once placed keeps its place through a near miss that would turn a newcomer away',()=>{
  const view={width:800,height:600,gap:3},anchor=item('ANCHOR',400,300,0),near=item('NEAR',400,300,1);
  // Ready to be kept: a neighbour's box has come close enough that a newcomer, wanting the whole gap, would look elsewhere, but it has not touched.
  const first=place([{...near,y:360}],view),keep=first[0].name;
  const box=first[0].box,wall={x:box.x-20,y:box.y+box.h+2,w:box.w+40,h:20};
  const kept=place([{...near,y:360}],{...view,obstacles:[wall],previous:{NEAR:keep}});
  assert.equal(kept[0].name,keep,'Still here');
  const fresh=place([{...near,y:360}],{...view,obstacles:[wall]});
  assert.notDeepEqual(fresh[0].box,box,'A newcomer keeps the fuller gap');
  assert.equal(anchor.id,'ANCHOR');
});

test('a name resting after being crowded out does not arrive anywhere, unless it was already placed',()=>{
  const view={width:800,height:600};
  assert.equal(place([{...item('RESTING',400,300,0),rest:true}],view)[0],null,'It waits');
  assert.ok(place([{...item('RESTING',400,300,0),rest:true}],{...view,previous:{RESTING:'below'}})[0],'A place it holds is its own');
  assert.ok(place([{...item('ACTIVE',400,300,-1),rest:true}],view)[0],'The port on show is always named');
});

test('the port on show keeps its name in a crowd whose others got there first',()=>{
  const view={width:800,height:600},names=['ROME','NAPLES','FLORENCE','BOLOGNA','VENICE','MILAN','TURIN','GENOA','PISA','SIENA'];
  const items=names.map((name,i)=>item(name,400+(i%4)*7,300+Math.floor(i/4)*6,i)),first=place(items,view),previous=new Map(first.flatMap((slot,i)=>slot?[[items[i].id,slot.name]]:[]));
  const hidden=first.findIndex(slot=>!slot),target=hidden<0?9:hidden;items[target].priority=-1;
  assert.ok(place(items,{...view,previous})[target],'The active port wins');
});
