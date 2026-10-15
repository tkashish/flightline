# Stack the frames of a clip's best track and circle the app's points (stabilized coords mapped to raw is skipped).
import json, subprocess, tempfile, os, sys
from PIL import Image, ImageDraw, ImageChops
obs_json, clip, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(obs_json)); W, H = d['W'], d['H']
c = max(d['cands'], key=lambda c: len(c['obs'])); o = [(k, x, y) for k, x, y, *_ in c['obs']]
k0, k1 = o[0][0], o[-1][0]
tmp = tempfile.mkdtemp()
subprocess.run(['ffmpeg','-v','error','-y','-i',clip,'-vf',f"select=between(n\\,{k0}\\,{k1})",'-vsync','0','-start_number',str(k0),os.path.join(tmp,'f%04d.png')],check=True)
im = Image.open(os.path.join(tmp, f'f{k0:04d}.png')).convert('RGB')
for k in range(k0 + 1, k1 + 1): im = ImageChops.lighter(im, Image.open(os.path.join(tmp, f'f{k:04d}.png')).convert('RGB'))
xs = [x * W for _, x, _ in o]; ys = [y * H for *_, y in o]
crop = (int(max(0, min(xs) - 150)), int(max(0, min(ys) - 150)), int(min(W, max(xs) + 150)), int(min(H, max(ys) + 150)))
im = im.crop(crop); dr = ImageDraw.Draw(im)
for k, x, y in o:
    X, Y = x * W - crop[0], y * H - crop[1]; dr.ellipse([X - 8, Y - 8, X + 8, Y + 8], outline=(255, 0, 0), width=3)
s = min(1, 900 / max(im.size)); im = im.resize((int(im.width * s), int(im.height * s)))
im.save(out); print(c['id'], len(o), 'frames', k0, k1)
