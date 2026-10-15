# Per-frame debug panels: left = colour crop around the ball (2x), right = the app's coarse grayscale view (pool 2, 4x)
# with every blob the detector listed near the ball. argv: frames.json frames-nocap.json original_dir out_dir
import json, sys, os
from PIL import Image, ImageDraw, ImageFont
J = json.load(open(sys.argv[1])); NC = json.load(open(sys.argv[2])); src = sys.argv[3]; out = sys.argv[4]
P, AX, AY, fps = J['pool'], J['AX'], J['AY'], J['fps']
BALL = {62, 598}                       # the app's two records of the address ball (spot ids s62, s598)
font = ImageFont.load_default(size=15) if hasattr(ImageFont, 'load_default') else None
def sim(f, x, y): s = f['sim']; return s['a'] * x - s['b'] * y + s['tx'], s['b'] * x + s['a'] * y + s['ty']
nocap = {f['index']: f for f in NC['frames']}
CW, CH = 320, 200                      # native crop (px)
rows = []
for f in J['frames']:
    k = f['index']; bx, by = sim(f, AX, AY)
    im = Image.open(os.path.join(src, f'frame_{k:03d}.jpg')).convert('RGB')
    x0, y0 = int(round(bx - CW / 2)), int(round(by - CH / 2))
    col = im.crop((x0, y0, x0 + CW, y0 + CH)).resize((CW * 2, CH * 2), Image.LANCZOS)
    g = im.convert('L'); g = g.resize((g.width // P, g.height // P), Image.BOX)
    cx0, cy0 = x0 / P, y0 / P
    app = g.crop((int(cx0), int(cy0), int(cx0) + CW // P, int(cy0) + CH // P)).resize((CW * 2, CH * 2), Image.NEAREST).convert('RGB')
    S = 2 * P / 1                       # coarse px -> panel px (4x)
    dr = ImageDraw.Draw(app)
    near = lambda x, y, r: abs(x - bx / P) < r and abs(y - by / P) < r
    listed = False
    for c in f['cands']:
        u, v = (c['x'] - int(cx0)) * S, (c['y'] - int(cy0)) * S
        if not (0 <= u < CW * 2 and 0 <= v < CH * 2): continue
        ball_like = c['pol'] > 0 and c['round'] <= J['params']['maxEigRatio'] and c['fill'] >= J['params']['minFill']
        colr = (0, 230, 0) if ball_like else ((255, 150, 0) if c['pol'] > 0 else (80, 140, 255))
        r = max(6, c['d'] / 2 * S)
        dr.ellipse([u - r, v - r, u + r, v + r], outline=colr, width=3)
        dr.text((u + r + 3, v - 8), f"round {c['round']:.2f}", fill=colr, font=font)
        if c['pol'] > 0 and near(c['x'], c['y'], 6): listed = True
    probe = [o for o in f['obs'] if o['spot'] in BALL and o['src'] == 'probe']
    for o in probe:
        px, py = sim(f, o['X'], o['Y']); u, v = (px / P - int(cx0)) * S, (py / P - int(cy0)) * S; r = max(6, (o['d'] or 8) / 2 * S)
        dr.rectangle([u - r - 4, v - r - 4, u + r + 4, v + r + 4], outline=(0, 230, 255), width=3)
    recs = sorted({f"s{o['spot']}" for o in f['obs'] if o['spot'] in BALL})
    would = any(c['pol'] > 0 and abs(c['x'] - bx / P) < 6 and abs(c['y'] - by / P) < 6 for c in nocap.get(k, {'cands': []})['cands'])
    if listed: status = 'ball listed by the detector'
    elif probe: status = 'NOT listed (192-blob cap full)' + ('' if would else '') + ' - found only by a second look at its old spot'
    elif would: status = 'NOT listed (192-blob cap full)'
    else: status = 'ball not seen'
    panel = Image.new('RGB', (CW * 4 + 10, CH * 2 + 52), (0, 0, 0))
    panel.paste(col, (0, 52)); panel.paste(app, (CW * 2 + 10, 52))
    pd = ImageDraw.Draw(panel)
    pd.text((8, 6), f"frame {k}  ({k / fps:.2f} s)   app's ball record: {', '.join(recs) or 'none'}", fill=(255, 255, 255), font=font)
    pd.text((8, 28), status, fill=(255, 255, 0), font=font)
    pd.text((CW * 2 + 18, 30), "what the app sees (grayscale, half resolution)", fill=(180, 180, 180), font=font)
    panel.save(os.path.join(out, f'frame_{k:03d}.png')); rows.append(panel)
# overview of frames 0-51
th = [r.resize((r.width // 4, r.height // 4)) for r in rows[:52]]
cols = 4; W, H = th[0].width, th[0].height
sheet = Image.new('RGB', (cols * W, ((len(th) + cols - 1) // cols) * H), (40, 40, 40))
for i, t in enumerate(th): sheet.paste(t, ((i % cols) * W, (i // cols) * H))
sheet.save(os.path.join(os.path.dirname(out), 'overview-frames-0-51.png'))
print('panels', len(rows), 'sheet', sheet.size)
