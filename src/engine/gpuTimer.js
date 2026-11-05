// GPU 计时基于 EXT_disjoint_timer_query_webgl2。查询不能嵌套，因此每个
// 带标签的区段都是紧接着开始 / 结束；结果会晚几帧才回来。
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.current = null;
    this.frame = null;
    this.ms = {};       // 每个标签平滑后的毫秒数
    this.total = 0;     // 所有标签平滑后的总和
  }

  get available() { return !!this.ext; }

  beginFrame() { if (this.ext) this.frame = []; }

  begin(label) {
    if (!this.ext || !this.frame) return;
    this.end();
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.current = { label, q };
  }

  end() {
    if (!this.current) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.frame.push(this.current);
    this.current = null;
  }

  endFrame() {
    if (!this.ext || !this.frame) return;
    this.end();
    this.pending.push(this.frame);
    this.frame = null;
    if (this.keep) return;     // 基准测试：全部保留给 drain()
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const f = this.pending[0];
      if (!gl.getQueryParameter(f[f.length - 1].q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      let sum = 0;
      for (const { label, q } of f) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
        if (disjoint) continue;
        this.ms[label] = this.ms[label] === undefined ? ms : this.ms[label] * 0.95 + ms * 0.05;
        sum += ms;
      }
      if (!disjoint) this.total = this.total ? this.total * 0.95 + sum * 0.05 : sum;
    }
    // ponytail: GPU 一直不回报时丢弃积压（标签页隐藏等）
    if (this.pending.length > 8) this.pending.splice(0, this.pending.length - 8).flat().forEach(({ q }) => gl.deleteQuery(q));
  }

  // 读取所有待处理查询（在 GPU 同步围栏之后调用）-> 每个标签每帧的平均毫秒数
  drain() {
    const gl = this.gl, sums = {};
    const frames = this.pending.length;
    for (const f of this.pending) for (const { label, q } of f) {
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) sums[label] = (sums[label] || 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
    }
    this.pending = [];
    for (const k in sums) sums[k] /= frames;
    return sums;
  }
}
