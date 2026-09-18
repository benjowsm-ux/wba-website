# WBA — Business UNusual

Working site: sharedStuff/WBA-Site-V2
Preview: http://localhost:4321/
Original concept remains unchanged at http://localhost:3000/.

The original concept’s blended seafront image, paper/green/lime palette and condensed typography now frame the working multi-page site. The original WBA logo is retained.

## Changes
- Homepage: clear £30/month package, three service routes, one selected-work section and contact.
- Removed free-versus-paid positioning, decorative wave, repeated slogans and service-to-single-project links.
- Website package page explains inclusions, separate services, domain costs and existing subscription/ownership terms.
- Portfolio opens directly into factual project captions; project pages return to the portfolio or an enquiry instead of cycling through projects.
- Contact form accepts an editable service selection, optional business and optional note. Website offer links preselect Website — £30/month. Continue in WhatsApp opens an encoded, editable message; it does not send it.
- Original backend, portal authentication and existing hosted/private preview support retained. Portal field remains blank, with access-code wording.

## Files and maintenance
Public presentation: css/unusual.css (layered over existing styles). Shared chrome: scripts/design. Enquiry behaviour: js/studio.js. Feed generation includes the new stylesheet and content-hashed assets.
Run locally with node scripts/serve.mjs 4321 from the site folder. Use existing Cloudflare/Netlify routing when deploying; plain GitHub Pages does not supply the portal API routes. GitHub Pages can still host client previews opened from the portal.

## Validation
30-page local link/asset/anchor audit passed. Existing sanitisation suite: 122 passed. New enquiry tests cover service preselection, invalid-service fallback, optional inputs and safe message encoding without transmission. Seed Feed generation passed in an isolated copy. Key public pages checked in browser at 390px with no horizontal overflow or broken loaded images. Desktop hero, mobile portfolio and enquiry form reviewed visually.

Not published. New number: 07447 571425. Activate the SIM/WhatsApp before release. Authenticated portal end-to-end verification still needs a real client account; no login codes, client writes or enquiries were sent during this work.
