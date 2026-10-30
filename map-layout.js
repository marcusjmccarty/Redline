/* Original map coordinates, shared by city markers and route geometry. */
(() => {
  const project=([longitude,latitude])=>[(longitude+180)*4,(90-latitude)*4];
  function route(interpolate){
    let path='',previous=null;
    for(let i=0;i<=240;i++){
      const point=project(interpolate(i/240));
      if(previous&&Math.abs(point[0]-previous[0])>720){
        // Split at the date line so the tracer never draws across the entire sheet.
        const right=previous[0]>720,edge=right?1440:0;
        const wrapped=point[0]+(right?1440:-1440);
        const y=previous[1]+(point[1]-previous[1])*(edge-previous[0])/(wrapped-previous[0]);
        path+=`L${edge},${y}M${right?0:1440},${y}`;
      }
      path+=`${previous?'L':'M'}${point[0]},${point[1]}`;
      previous=point;
    }
    return path;
  }
  globalThis.RedlineLayout=Object.freeze({project,route});
})();
