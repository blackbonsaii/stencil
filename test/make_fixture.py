"""Generate a reference image + the exact job bytes the proven Python path sends."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from PIL import Image, ImageDraw
from tp88 import to_bitmap
from bleprint import job  # safe: bleprint only prints under __main__
out = os.path.dirname(os.path.abspath(__file__))
img = Image.new("L", (1664, 600), 255)
d = ImageDraw.Draw(img)
d.rectangle([0, 0, 1663, 599], outline=0, width=3)     # ink on first + last row
d.ellipse([300, 100, 900, 500], fill=90)
d.line([0, 599, 1663, 0], fill=140, width=5)            # grey: tests threshold
for x in range(0, 1664, 7): d.point((x, 300), fill=127) # just under threshold 128
img.save(f"{out}/fixture.png")
open(f"{out}/fixture.gray", "wb").write(img.tobytes())
raw, h = to_bitmap(img, 208, threshold=128)
open(f"{out}/fixture.job", "wb").write(job(raw, h, density=5))
print("fixture", img.size, "job bytes", len(job(raw, h, density=5)))
