// For hypothesis spot argv[3]: the club track the LaunchConfirmer uses vs the top streak chain's samples.
import { openNodeSource } from '../../tests/hf/helpers/node-source.mjs';
import { analyzeClip, defaultModules } from '../../dist/hf/pipeline.js';
import { mergeParams } from '../../dist/hf/params.js';
const src = await openNodeSource(process.argv[2]), want = process.argv[3], M = await defaultModules(), r1 = v => +(+v).toFixed(1);
let best = null;
class LogLC extends M.LaunchConfirmer {
  evaluateStreak(chain, ctx, segs, anchor) {
    const e = super.evaluateStreak(chain, ctx, segs, anchor);
    if (this.hyp.spotId === want && ctx.imp === this.real && Math.hypot(anchor.x - this.hyp.address.x, anchor.y - this.hyp.address.y) < 1 && (!best || e.S > best.e.S) && e.law?.ok)
      best = { e, club: e.club, A: anchor };
    return e;
  }
}
await analyzeClip(src, { diagnostics: true, modules: { ...M, LaunchConfirmer: LogLC }, onProgress: () => {}, params: mergeParams(JSON.parse(process.env.OVR ?? '{}')) });
if (!best) { console.log('no streak chain'); process.exit(); }
const { e, club, A } = best, ck = club ? Object.keys(club) : [];
console.log('fail', e.fail, 'S', e.S, 'address', r1(A.x), r1(A.y), 'club keys', ck.join(','), 'club T', club?.T, 'dir', JSON.stringify(club?.dir));
for (const q of e.support) {
  const pts = club?.points ?? club?.samples ?? club?.track ?? [];
  const pt = (Array.isArray(pts) ? pts : []).find(p => (p.k ?? p.index) === q.k);
  console.log(`  k ${q.k} ball (${r1(q.x)},${r1(q.y)}) len ${r1(q.len)}  club ${pt ? `(${r1(pt.x)},${r1(pt.y)})` : '-'}  dist ${pt ? r1(Math.hypot(pt.x - q.x, pt.y - q.y)) : '-'}`);
}
if (club) console.log("club points", JSON.stringify(club.points.slice(0, 14).map(p => [p.index, r1(p.x), r1(p.y), p.measured ? "M" : "-"])), "impactVel", JSON.stringify(club.impactVel));
