// Dissolve the bundled, shared country edges once, before publication. No
// polygon clipping, topology work, or external data is needed in the browser.
export function dissolve(paths){
  const edges=new Map();
  for(const path of paths)for(const part of path.split('M').filter(Boolean)){
    const points=[...part.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m=>`${Number(m[1])},${Number(m[2])}`);
    if(points.at(-1)===points[0])points.pop();
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length];if(a===b)continue;
      const key=[a,b].sort().join('|'),edge=edges.get(key);
      if(edge)edge.count++;else edges.set(key,{a,b,count:1});
    }
  }
  const coast=[...edges.values()].filter(edge=>edge.count===1),internal=[...edges.values()].filter(edge=>edge.count===2),adjacent=new Map();
  if([...edges.values()].some(edge=>edge.count>2))throw Error('Atlas edges overlap; inspect the source geometry.');
  for(const [id,edge] of coast.entries())for(const point of [edge.a,edge.b]){
    if(!adjacent.has(point))adjacent.set(point,[]);adjacent.get(point).push(id);
  }
  if([...adjacent.values()].some(edges=>edges.length!==2))throw Error('Coastlines must be closed before publication.');
  const visited=new Set(),rings=[];
  for(let id=0;id<coast.length;id++){
    if(visited.has(id))continue;
    const start=coast[id].a,ring=[];let point=start;
    do{
      ring.push(point.split(',').map(Number));
      const next=adjacent.get(point).find(edge=>!visited.has(edge));
      if(next===undefined)throw Error('An atlas coastline failed to close.');
      visited.add(next);const edge=coast[next];point=edge.a===point?edge.b:edge.a;
    }while(point!==start);
    const area=Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p[0]*q[1]-q[0]*p[1];},0)/2);
    rings.push({ring,area,parent:null});
  }
  const contains=(ring,[x,y])=>{
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }
    return inside;
  };
  rings.sort((a,b)=>b.area-a.area);
  // Lake holes and islands inside them retain even-odd topology.
  for(let i=0;i<rings.length;i++)for(let j=i-1;j>=0;j--)if(contains(rings[j].ring,rings[i].ring[0])){rings[i].parent=rings[j];break;}
  const groups=new Map();
  for(const entry of rings){let root=entry;while(root.parent)root=root.parent;if(!groups.has(root))groups.set(root,[]);groups.get(root).push(entry.ring);}
  const land=[...groups.values()].map(group=>group.map(ring=>ring.map((point,i)=>`${i?'L':'M'}${point.join(',')}`).join('')+'Z').join(''));
  const chunks=new Map();
  for(const edge of internal){
    const [ax,ay]=edge.a.split(',').map(Number),[bx,by]=edge.b.split(',').map(Number),cell=`${Math.floor((ax+bx)/320)},${Math.floor((ay+by)/240)}`;
    if(!chunks.has(cell))chunks.set(cell,[]);chunks.get(cell).push(`M${edge.a}L${edge.b}`);
  }
  return {land,borders:[...chunks.values()].map(lines=>lines.join(''))};
}
