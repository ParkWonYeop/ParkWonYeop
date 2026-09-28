#!/usr/bin/env python3
"""Build the profile images.

1. Draw a night map of Gangnam from R-08's OpenStreetMap road data.
2. Render every tile in profile.html to WebP with headless Chrome.
3. Wrap the hero renders in SVGs that animate a light along Teheran-ro.

Usage: python3 design/build.py   (needs Google Chrome and an authenticated gh; stdlib only)
"""
import base64
import json
import math
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
ASSETS = ROOT.parent / "assets"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
# r08 is private, so fetch through the authenticated gh CLI
ROADS = "repos/ParkWonYeop/r08/contents/data/gangnam/source/roads.json"
SCALE = 2  # device pixel ratio of the renders

# Line 2 stations along Teheran-ro, west to east.
STATIONS = [
    ("GANGNAM", 37.49794, 127.02761),
    ("YEOKSAM", 37.50064, 127.03646),
    ("SEOLLEUNG", 37.50449, 127.04905),
    ("SAMSEONG", 37.50887, 127.06313),
]
ROAD_STYLE = {  # highway class -> (stroke width, opacity)
    "motorway": (2.4, 0.62), "trunk": (2.4, 0.62), "primary": (2.0, 0.55),
    "secondary": (1.5, 0.42), "tertiary": (1.1, 0.32),
    "motorway_link": (1.2, 0.4), "trunk_link": (1.2, 0.4), "primary_link": (1.1, 0.36),
    "residential": (0.7, 0.2), "living_street": (0.6, 0.16), "unclassified": (0.6, 0.16),
}
GLOW = {"motorway", "trunk", "primary"}

# name -> (width, height, map center (lat, lon), canvas point for that center, px per km, animated)
TILES = {
    "hero": (1200, 520, (37.5036, 127.0460), (790, 300), 205, True),
    "hero-mobile": (600, 760, (37.5036, 127.0460), (330, 560), 128, True),
    "project-wnote": (1200, 560, None, None, None, False),
    "project-r08": (1200, 560, None, None, None, False),
    "project-blog": (1200, 560, None, None, None, False),
    "project-wnote-mobile": (600, 700, None, None, None, False),
    "project-r08-mobile": (600, 700, None, None, None, False),
    "project-blog-mobile": (600, 700, None, None, None, False),
}


def projector(center, origin, px_per_km):
    lat0, lon0 = center
    kx = 111.32 * math.cos(math.radians(lat0)) * px_per_km
    ky = 110.57 * px_per_km
    return lambda lat, lon: (origin[0] + (lon - lon0) * kx, origin[1] - (lat - lat0) * ky)


def path_d(points):
    return "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in points)


def teheran_route(ways, project):
    # Teheran-ro is split into one-way carriageways; keep the eastbound one and order it west to east.
    points = {
        (p["lat"], p["lon"])
        for w in ways
        if w["tags"].get("name") == "테헤란로" and w["geometry"][-1]["lon"] > w["geometry"][0]["lon"]
        for p in w["geometry"]
    }
    return [project(lat, lon) for lat, lon in sorted(points, key=lambda p: p[1])]


def map_svg(ways, w, h, project):
    groups = {}
    for way in ways:
        style = ROAD_STYLE.get(way["tags"].get("highway"))
        if not style:
            continue
        pts = [project(p["lat"], p["lon"]) for p in way["geometry"]]
        if all(x < -40 or x > w + 40 or y < -40 or y > h + 40 for x, y in pts):
            continue
        groups.setdefault(way["tags"]["highway"], []).append(path_d(pts))
    layers, glow = [], []
    for kind, paths in groups.items():
        width, opacity = ROAD_STYLE[kind]
        layers.append(f'<path d="{"".join(paths)}" stroke-width="{width}" stroke-opacity="{opacity}"/>')
        if kind in GLOW:
            glow.append(f'<path d="{"".join(paths)}" stroke-width="{width * 5}" stroke-opacity="0.16"/>')
    stations = []
    for name, lat, lon in STATIONS:
        x, y = project(lat, lon)
        stations.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="11" fill="#FFB547" opacity="0.18"/>'
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" fill="#FFE3B0"/>'
            f'<text x="{x + 10:.1f}" y="{y - 12:.1f}">{name}</text>'
        )
    return (
        f'<svg class="map" viewBox="0 0 {w} {h}" width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg">'
        '<defs><filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter></defs>'
        f'<g fill="none" stroke="#FF9F2E" stroke-linecap="round" stroke-linejoin="round" filter="url(#blur)">{"".join(glow)}</g>'
        f'<g fill="none" stroke="#FFB85C" stroke-linecap="round" stroke-linejoin="round">{"".join(layers)}</g>'
        f'<g class="stations">{"".join(stations)}</g>'
        "</svg>"
    )


def hero_svg(name, w, h, webp, route):
    d = path_d(route)
    image = base64.b64encode(webp).decode()
    # ponytail: fixed 9s loop; the light fades out before it restarts at the west end
    return f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="title">
  <title id="title">Park Won Yeop — 직접 만들고, 직접 운영합니다</title>
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="frame"><rect width="{w}" height="{h}" rx="28"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <image width="{w}" height="{h}" href="data:image/webp;base64,{image}" xlink:href="data:image/webp;base64,{image}"/>
    <path id="route" d="{d}" fill="none" stroke="#FFD9A0" stroke-width="1.6" stroke-opacity="0.35"/>
    <path d="{d}" fill="none" stroke="#FFC46B" stroke-width="3" stroke-linecap="round" pathLength="1000" stroke-dasharray="140 1000" stroke-dashoffset="140" filter="url(#glow)">
      <animate attributeName="stroke-dashoffset" values="140;-1000;-1000" keyTimes="0;0.85;1" dur="9s" repeatCount="indefinite"/>
    </path>
    <circle r="4.5" fill="#FFF4DE" opacity="0" filter="url(#glow)">
      <animateMotion dur="9s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.85;1" calcMode="linear"><mpath href="#route" xlink:href="#route"/></animateMotion>
      <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.04;0.8;0.85;1" dur="9s" repeatCount="indefinite"/>
    </circle>
  </g>
</svg>
"""


def render(html, name, w, h):
    out = ASSETS / f"{name}.webp"
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--default-background-color=00000000",
         f"--force-device-scale-factor={SCALE}", f"--window-size={w},{h}", "--virtual-time-budget=6000",
         f"--screenshot={out}", f"file://{html}#{name}"],
        check=True, capture_output=True,
    )
    return out


def main():
    raw = subprocess.run(["gh", "api", ROADS, "-H", "Accept: application/vnd.github.raw"], check=True, capture_output=True).stdout
    ways = json.loads(raw)["elements"]
    template = (ROOT / "profile.html").read_text()
    routes = {}
    for name, (w, h, center, origin, px_per_km, _) in TILES.items():
        if center:
            project = projector(center, origin, px_per_km)
            template = template.replace(f"<!--map:{name}-->", map_svg(ways, w, h, project))
            routes[name] = teheran_route(ways, project)
    with tempfile.NamedTemporaryFile("w", suffix=".html", dir=ROOT, delete=False) as f:
        f.write(template)
        built = pathlib.Path(f.name)
    try:
        for name, (w, h, _, _, _, animated) in TILES.items():
            out = render(built, name, w, h)
            if animated:
                (ASSETS / f"{name}.svg").write_text(hero_svg(name, w, h, out.read_bytes(), routes[name]))
                out.unlink()
            print(name, "ok")
    finally:
        built.unlink()


if __name__ == "__main__":
    main()
