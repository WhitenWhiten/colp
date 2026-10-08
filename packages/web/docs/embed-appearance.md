# Embedded Collection and News Digest appearance

Public guide: [HTML](https://know-n.com/embed-guide) · [Markdown](https://know-n.com/embed-guide.md).
The maintained public source is `content/agent-public/embed-guide.md`; run
`npm run generate:agent-public` after editing it. The generator publishes HTML
and Markdown, and the HTML route is listed in `sitemap-static.xml`. Keep this
implementation reference and the public parameter contract aligned.

On a collection's share page, expand **Customize appearance**, adjust settings,
then use **Copy embed**. The preview and snippet use the same validated settings.
Reset appearance clears overrides without changing theme or compact mode.

The existing `/share/:slug?embed=1` URL supports these optional query parameters:

| Parameter | Accepted values |
| --- | --- |
| `theme` | `light` (default), `dark`, `auto` (visitor OS preference) |
| `compact` | Presence hides summary/curator and sizes the suggested height for three preview rows |
| `bg`, `text`, `muted`, `accent`, `line` | Six-digit hex color, including `#` (URL-encode as `%23`) |
| `font` | `default`, `sans`, `serif`, `mono` |
| `metaFont` | `default`, `sans`, `mono` |
| `density` | `default`, `comfortable`, `tight` |
| `divider` | `solid`, `dotted`, `dashed` |
| `decoration` | `none`, `checker` |
| `fontSize` | Integer 12–18, resource text size in px; title is 4px larger |
| `padding` | Integer 8–28, horizontal content padding in px |
| `radius` | Integer 0–24; used by the snippet generator for the outer iframe |

Invalid and unknown values are ignored. Unspecified values use existing styling.
Color overrides take precedence over the selected theme, including auto mode.
Fonts are bundled/system presets: no external stylesheets or font URLs are accepted.
Use contrasting text/background colors; the footer independently chooses black or
white when a background override is supplied, and the Know-N wordmark switches to
its light-on-dark variant on a dark background (or the dark theme). Attribution and
Open cannot be hidden or redirected through appearance parameters.

Example monochrome configuration:

```text
/share/example?embed=1&bg=%23ffffff&text=%231a1a1a&muted=%236b6b6b&accent=%231a1a1a&line=%23e3e3e3&font=sans&metaFont=mono&divider=dotted&decoration=checker&radius=0
```

Iframe borders and corner radius belong to the host, so changing `radius`
in a hand-written URL alone does not style the frame. The generated snippet
paints them on a wrapper element around the iframe — a border on the iframe's
own box can lose to the embedded document's composited layer at fractional
device pixels. Copy the generated snippet or set equivalent wrapper CSS
yourself. Width remains responsive down to narrow frames; the generator adds
height for larger text and comfortable spacing. Particularly narrow embeds may
still truncate content; adjust the iframe height as appropriate. The card posts
a `known:embed-resize` message with its suggested height (`suggestEmbedHeight`)
to the embedding window for hosts that opt into auto-sizing.

Configuration is local to each embed. It does not modify the collection or grant
access to unpublished content. No raw CSS, HTML, JavaScript, remote URLs, arbitrary
custom-property names, or visibility controls are accepted. Browser framing cannot
prevent a host from covering or cropping a card; retained attribution is a component
contract, not a guarantee against deliberate host-page manipulation.

## News Digest

Digest series and individual issues provide the same Embed editor on their public
pages. The generated iframe uses:

- Series: `/reports/:slug?embed=1` — the series title/summary and links from its
  newest readable issue. Hidden editions are skipped. New loads/revalidation use
  the current latest issue; there is no background polling.
- Single issue: `/reports/:slug/issues/:editionId?embed=1` — the chosen issue's
  title/summary/date and its public source collection, matching the normal issue
  page. The issue identity is fixed; its referenced source remains live.

Both share the Collection card renderer, typography, appearance controls, link
rows and Know-N footer. The `+N more` link opens the issue; the footer opens the
series or fixed issue respectively. Digest cards reserve extra height for the
edition/date line. An empty series remains a valid card. Hidden issues, withdrawn
sources and deployments with Digest disabled never fall back to another source.
Normal Digest pages remain non-frameable; only `embed=1` enables framing.
