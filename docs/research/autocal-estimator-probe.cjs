const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../auto-flow-cal.reaplugin/plugin.js'), 'utf8');
const estimator = vm.runInNewContext(source + '\ncreatePlugin')({log(){},storage(){}}).__test;
function shot({pressure=9,noise=0,flowSlope=0}={}) {
  const measurements=[];
  for(let i=0;i<=40;i++) {
    const t=i*.25, timestamp=new Date(t*1000).toISOString();
    measurements.push({machine:{timestamp,state:{state:'espresso',substate:'pouring'},pressure,flow:2+flowSlope*t}});
    measurements.push({scale:{timestamp,weight:5+.9*(2*t+flowSlope*t*t/2),weightFlow:.9*(2+flowSlope*t)+noise*(i%2?1:-1)}});
  }
  return {workflow:{machine:{flowCalibration:1}},measurements};
}
for(const [name,options,accepted] of [
  ['steady reference',{},true],
  ['accurate cumulative weight; weightFlow jitter ±0.05 g/s',{noise:.05},false],
  ['constant 9 bar; matched rising flows 0.4 ml/s²',{flowSlope:.4},false],
  ['steady 1.5 bar; matched flow and weight',{pressure:1.5},false]
]) {
  const result=estimator.estimateShot(shot(options));
  assert.equal(result.accepted,accepted,name);
  console.log(JSON.stringify({name,...result}));
}
