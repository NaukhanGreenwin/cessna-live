# Cessna Live

A phone-first page that shows the live position of one aircraft, looked up by registration, from public ADS-B data.

- Full-screen map (Leaflet, OpenStreetMap tiles; the dark style is a CSS filter, so no tile API key is needed)
- Card with registration, status (airborne, on ground, not seen), altitude, ground speed, track, vertical rate and the age of the last position
- Aircraft icon rotated to its track, trail of the last 200 positions in this session
- Follow toggle, 5 second polling with back-off on errors
- Default registration set by `DEFAULT_REG` in `app.js`, pre-filled on first open; the Aircraft button or `?reg=C-XXXX` overrides it and the choice is saved on the device
- Web manifest and Apple touch icon so it can be added to the home screen

## Data

Positions come from community ADS-B networks ([adsb.lol](https://api.adsb.lol/), fallback [adsb.fi](https://github.com/adsbfi/opendata)). Those APIs do not send CORS headers, so the page calls a tiny proxy (`proxy/server.js`, Node, no dependencies) that forwards the request and adds them. The proxy caches each lookup for two seconds.

An aircraft only appears when it is transmitting ADS-B out and is within range of a community receiver. Aircraft without ADS-B out will show as "not seen".

## Run locally

```
node proxy/server.js                      # proxy on http://localhost:10000
python3 -m http.server 8080               # page on http://localhost:8080
open "http://localhost:8080/?reg=C-XXXX&api=http://localhost:10000"
```

The `api` query parameter overrides the proxy URL and is remembered.

## Deploy

- Page: any static host (GitHub Pages works as is, everything is relative).
- Proxy: any Node 20+ host. Start command `node server.js`, root directory `proxy`, health check `/health`. Set `DEFAULT_API` in `app.js` to the proxy URL.

Icons are generated with `python3 tools/make_icons.py` (needs Pillow).

## Licence

MIT. Leaflet is BSD-2-Clause (vendored in `vendor/leaflet`). Map tiles: OpenStreetMap contributors.
