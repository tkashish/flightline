# Draw the triage hypotheses on the clip's address frame K (half scale). argv: json, clip, out.png
import json, subprocess, sys, tempfile, os
from PIL import Image, ImageDraw
j = json.load(open(sys.argv[1])); clip = sys.argv[2]; out = sys.argv[3]
tmp = tempfile.mkdtemp()
fr = os.path.join(tmp, 'f.png')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', clip, '-vf', f"select=eq(n\\,{j['K']})", '-frames:v', '1', fr], check=True)
im = Image.open(fr).convert('RGB'); S = 0.5
im = im.resize((int(im.width * S), int(im.height * S)))
dr = ImageDraw.Draw(im)
for h in j['all']:
    x, y, r = h['rx'] * S, h['ry'] * S, max(7, h['d'] * S * 0.8)
    col = (255, 40, 40) if h['rank'] <= 8 else (255, 220, 0)
    dr.ellipse([x - r, y - r, x + r, y + r], outline=col, width=2)
    dr.text((x + r + 2, y - 6), f"#{h['rank']} k{h['k']}", fill=col)
dr.text((6, 6), f"{j['clip']}  frame {j['K']}/{j['n']}  {j['fps']:.0f}fps  {j['status']} {','.join(j['reasons'])}", fill=(0, 255, 0))
im.save(out)
