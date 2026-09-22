# docs/diagrams

The canonical layered diagram. `layers.html` is the source of truth; the PNGs
are rendered from it.

## Rebuilding

```sh
export CHROME_PATH=/path/to/chrome-headless-shell
bun run export.ts "$PWD/layers.html" "$PWD" layers 1280 760
```

Each call writes `-light.png` and `-dark.png` at 2× device scale, one per colour
scheme.

## Why PNG and not SVG

Chrome has no HTML → SVG path. Routing through PDF and `pdftocairo -svg`
outlines every glyph — the result has zero `<text>` elements, so it buys nothing
over a raster and costs 40× the bytes. `layers.html` is the greppable, diffable
source; the PNG is the artefact.

## Embedding both themes

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="layers-dark.png">
  <img alt="Jean's four layers, each built on the one below" src="layers-light.png">
</picture>
```

Never inline SVG in a GitHub README — the sanitizer strips the element. This
`<picture>` form is the supported theme switch, and GitHub wraps it in its own
`themed-picture` element.

## A note that belongs beside the diagram, not in it

The code is flat. All eleven `src/domain` modules import their own contract and
the shared vocabulary and nothing else; composition belongs to the adapter. The
layering here is an ordering of **guarantees**, not of modules — which is the
stronger claim, because it is why a layer can be reasoned about, and tested,
alone.
