# What the ball looks like right after the hit: frames k..k+3 cropped above the address (0.6x), plus the full frame
# with frames k+1..k+10 stacked (lighter blend, 0.3x) so the flight path shows. argv: clip ax ay k out.png
import sys, os, subprocess, tempfile
from PIL import Image, ImageDraw, ImageChops
clip, ax, ay, k, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
tmp = tempfile.mkdtemp()
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', clip, '-vf', f"select=between(n\\,{k - 1}\\,{k + 10})", '-vsync', '0', '-start_number', str(k - 1), os.path.join(tmp, 'f%04d.png')], check=True)
fr = lambda i: Image.open(os.path.join(tmp, f'f{i:04d}.png')).convert('RGB')
W, H = fr(k).size
x0, y0, x1, y1 = int(ax - 260), int(ay - 520), int(ax + 260), int(ay + 80)
tiles = []
for i in range(k, k + 4):
    t = fr(i).crop((x0, y0, x1, y1)); t = t.resize((int(t.width * 0.6), int(t.height * 0.6)))
    d = ImageDraw.Draw(t); d.text((4, 4), f'frame {i}' + (' (last on mat)' if i == k else ''), fill=(255, 255, 0))
    cx, cy = (ax - x0) * 0.6, (ay - y0) * 0.6; d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], outline=(255, 0, 0), width=2)
    tiles.append(t)
st = fr(k + 1)
for i in range(k + 2, k + 11): st = ImageChops.lighter(st, fr(i))
st = st.resize((int(W * 0.3), int(H * 0.3))); d = ImageDraw.Draw(st); d.text((4, 4), f'frames {k + 1}-{k + 10} stacked', fill=(255, 255, 0))
d.ellipse([ax * 0.3 - 6, ay * 0.3 - 6, ax * 0.3 + 6, ay * 0.3 + 6], outline=(255, 0, 0), width=2)
tw, th = tiles[0].size
canvas = Image.new('RGB', (4 * tw + st.width + 50, max(th, st.height)), (30, 30, 30))
for j, t in enumerate(tiles): canvas.paste(t, (j * (tw + 10), 0))
canvas.paste(st, (4 * (tw + 10) + 10, 0))
canvas.save(out)
