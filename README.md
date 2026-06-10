# BannerBye — Deploy folder

Deze folder is klaar om direct naar Vercel te slepen. Alles in deze map gaat naar bannerbye.com.

## Inhoud

- `index.html` — de landingspagina (1 bestand met Tailwind CDN, inline SVG, inline animaties)
- `404.html` — Not found pagina met BannerBye-huisstijl
- `vercel.json` — security headers + redirects (`/waitlist` en `/join` → `#waitlist` anchor)
- `robots.txt` — crawlers welkom, verwijst naar sitemap
- `sitemap.xml` — één URL (de homepage)

## Voor je deployt — 1 ding aanpassen

Open `index.html` en vervang `REPLACE_WITH_FORM_ID` door je ConvertKit form ID.

Zoek:
```
action="https://app.kit.com/forms/REPLACE_WITH_FORM_ID/subscriptions"
```

Vervang door (voorbeeld):
```
action="https://app.kit.com/forms/1234567/subscriptions"
```

## Deployen — twee opties

**Drag-and-drop (snelste, 5 min):**
1. Ga naar vercel.com/new
2. Sleep deze hele `deploy/` folder in de upload-zone
3. Project name: `bannerbye`, Framework: Other, rest leeg
4. Deploy → krijgt `bannerbye-xyz.vercel.app` URL
5. Settings → Domains → add `bannerbye.com` + `www.bannerbye.com`
6. DNS records uit Vercel kopiëren naar je registrar

**Vercel CLI (aanbevolen voor iteraties):**
```bash
npm i -g vercel
cd /pad/naar/deploy
vercel --prod
```

Volledige step-by-step staat in `../BannerBye_Deployment_v1.md`.

## Wat checkt `vercel.json` voor je

- HSTS (`Strict-Transport-Security`) — dwingt HTTPS af
- Clickjacking-bescherming (`X-Frame-Options: DENY`)
- MIME-sniffing uit (`X-Content-Type-Options: nosniff`)
- Referrer policy — alleen origin delen, niet de volle URL
- Permissions policy — camera/mic/geolocation/FLoC uit
- `cleanUrls` — `/thanks.html` wordt `/thanks`
- Redirects — `bannerbye.com/waitlist` springt naar het form-anchor

## Security headers testen na deploy

Open https://securityheaders.com en vul bannerbye.com in. Je zou minimaal een A moeten scoren met deze config.
