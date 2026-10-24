/** Actual rendered-frame timing. The optional inspector consumes this, never the scene clock clamp. */
export class FrameProfiler {
  constructor() { this.active=false; this.intervals=[]; this.last=null; }
  start() { this.active=true; this.intervals=[]; this.last=null; }
  get frameCount() { return this.intervals.length; }
  push(time) {
    if (!this.active || !Number.isFinite(time)) return;
    if (this.last!==null && time>this.last) this.intervals.push(time-this.last);
    this.last=time;
  }
  finish() {
    this.active=false;
    const sorted=[...this.intervals].sort((a,b)=>a-b);
    const n=sorted.length;
    const at=q=>n?sorted[Math.min(n-1,Math.floor((n-1)*q))]:0;
    const total=this.intervals.reduce((sum,value)=>sum+value,0);
    return {frames:n,durationSeconds:total/1000,medianFps:n?1000/at(.5):0,p95FrameMs:at(.95),maxFrameMs:n?sorted[n-1]:0,over50ms:this.intervals.filter(t=>t>50).length,over250ms:this.intervals.filter(t=>t>250).length};
  }
}

