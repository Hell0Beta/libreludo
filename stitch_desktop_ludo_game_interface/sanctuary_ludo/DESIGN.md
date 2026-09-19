---
name: Sanctuary Ludo
colors:
  surface: '#fff9e9'
  surface-dim: '#dfdac9'
  surface-bright: '#fff9e9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f9f3e2'
  surface-container: '#f4eedd'
  surface-container-high: '#eee8d7'
  surface-container-highest: '#e8e2d1'
  on-surface: '#1e1c12'
  on-surface-variant: '#404940'
  inverse-surface: '#333125'
  inverse-on-surface: '#f6f0df'
  outline: '#70796f'
  outline-variant: '#c0c9bd'
  surface-tint: '#296b3c'
  primary: '#11562a'
  on-primary: '#ffffff'
  primary-container: '#2e6f40'
  on-primary-container: '#aaefb4'
  inverse-primary: '#92d69d'
  secondary: '#b81b34'
  on-secondary: '#ffffff'
  secondary-container: '#ff5261'
  on-secondary-container: '#5b0012'
  tertiary: '#624500'
  on-tertiary: '#ffffff'
  tertiary-container: '#805c00'
  on-tertiary-container: '#ffda97'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#adf3b8'
  primary-fixed-dim: '#92d69d'
  on-primary-fixed: '#00210b'
  on-primary-fixed-variant: '#0a5226'
  secondary-fixed: '#ffdad9'
  secondary-fixed-dim: '#ffb3b3'
  on-secondary-fixed: '#40000a'
  on-secondary-fixed-variant: '#920022'
  tertiary-fixed: '#ffdea5'
  tertiary-fixed-dim: '#f9bd3a'
  on-tertiary-fixed: '#271900'
  on-tertiary-fixed-variant: '#5d4200'
  background: '#fff9e9'
  on-background: '#1e1c12'
  surface-variant: '#e8e2d1'
typography:
  display-lg:
    fontFamily: Epilogue
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Epilogue
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Epilogue
    fontSize: 26px
    fontWeight: '700'
    lineHeight: 34px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Epilogue
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  headline-sm:
    fontFamily: Epilogue
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 28px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
  label-lg:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: '700'
    lineHeight: 20px
    letterSpacing: 0.06em
  label-md:
    fontFamily: Space Grotesk
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.08em
  label-sm:
    fontFamily: Space Grotesk
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.1em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1.5rem
  margin: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

This design system channels the warmth, curiosity, and pastoral mysticism of a hand-painted Studio Ghibli enchanted forest shrine, blended seamlessly with the clarity of a tactile desktop digital board game. 

The aesthetic is grounded in **Tactile / Skeuomorphic Fantasy**. It favors organic textures over sterile digital minimalism: hand-chiseled stone pavers, aged cedar shrines, warm moss-draped edges, glowing golden paper lantern light, and ancient runic engravings. 

Interactive elements evoke real physical weights—heavy stone tablets that seat into forest turf with satisfying friction, polished jade and jasper dice that roll with gentle inertia, and mystical glowing glyphs that awaken upon hover. The target audience seeks cozy comfort, tactical multiplayer fun, and an immersive, heartwarming escape into a secret spirit sanctuary.

## Colors

The palette establishes four distinctive quadrant realms directly derived from traditional Ludo rules, reimagined as mythical forest sanctuary elements:

- **Moss Green (`#2E6F40`)**: Primary quadrant & dominant foliage tone. Represents the ancient grove spirits, earth, and vitality. Used for natural UI accents, success indicators, and player 1 markers.
- **Shrine Crimson (`#D63447`)**: Secondary quadrant. Represents sacred torii shrine gates, autumn maples, and ceremonial seals. Used for critical alerts, turn highlights, and combat actions.
- **Solar Yellow (`#EBB02D`)**: Tertiary quadrant. Represents paper lantern firelight, midday sun filtering through tree canopies, and golden spirit embers. Used for dice rolls, rewards, and active turn banners.
- **Mystical Azure (`#1E6091`)**: Quaternary quadrant. Represents clear shrine brooks, mountain spring waters, and luminescent mist. Used for informational alerts, navigation markers, and spirit mana indicators.
- **Parchment Stone (`#F4EEDD`)**: Foundational canvas surface. Evokes sun-warmed granite tiles, handmade washi paper scrolls, and weathered limestone.
- **Deep Bark Slate (`#222831`)**: Foundational dark neutral. Represents damp old-growth tree bark, night shadows, and chiseled dark slate. Used for primary typography, board frames, and contrast depth.

## Typography

The typography unites playful fantasy wonder with crisp, functional legibility:

- **Display & Headlines (`Epilogue`)**: Geometric, robust, and full of sculpted character. High weights give game headers, turn alerts, and victory banners a blocky, hand-carved presence reminiscent of ancient woodcut emblems and temple signage.
- **Body & Dialogue (`Plus Jakarta Sans`)**: Warm, humanist, rounded, and welcoming. Provides smooth legibility against textured stone backgrounds for chat windows, game logs, rules dialogs, and character lore.
- **Game Metrics & Tactical HUD (`Space Grotesk`)**: Technical yet quirky. Applied in all-caps or tabular forms for turn timers, score counts, coordinate indices, rune slot tallies, and dice modifier badges.

## Layout & Spacing

The layout is tailored for desktop widescreen displays (16:9 and 16:10), prioritizing the central 3D/isometric stone board sanctuary while framing it with ergonomic player HUD modules.

- **Primary Canvas**: Uses a contextual 3-pane desktop structure. The center canvas is reserved for the square Ludo stone sanctuary board (locked aspect ratio, maximum 800x800px on desktop).
- **HUD Flanks**: Left and right sidebars (width: 320px–360px each) hold the four player quadrant dossiers, forest spirits inventory, game log, and active dice tray.
- **Rhythm & Grid**: An 8pt spatial baseline determines interior module padding. Component padding utilizes `space-sm` (8px) for compact badges, `space-md` (16px) for cards, and `space-lg` (24px) for major modal panels.
- **Responsive Adaptation**:
  - *Desktop (>1200px)*: Full 3-column tactical view with floating HUD panels over atmospheric foliage edge art.
  - *Tablet (768px–1199px)*: HUD collapses into collapsible stone parchment drawers anchored along the bottom and right edges.
  - *Mobile (<768px)*: Fullscreen vertical stack where the sanctuary board occupies the upper screen and an interactive bottom sheet controls rolling, player turns, and piece selection.

## Elevation & Depth

Elevation simulates real, physical layers of stone, carved wood, and forest groundcover, avoiding sterile flat drops:

- **Tier 0 (The Forest Ground)**: Deep forest canopy background with atmospheric mist, painted moss floor, and low ambient vignetting.
- **Tier 1 (The Shrine Courtyard & Tablet Containers)**: Chiseled warm stone tiles (`#F4EEDD`) framed by deep slate borders (`#222831` at 2px–3px line weights) with directional earth drop shadows (`0 8px 24px rgba(34, 40, 49, 0.22)`).
- **Tier 2 (Interactive Dice, Counters & Action Cards)**: Cast resin/carved wood pieces seated in recessed sockets. When idle, they carry sharp, short contact shadows (`0 3px 6px rgba(34, 40, 49, 0.3)`).
- **Tier 3 (Floating HUD & Spirit Modals)**: Suspended wooden lanterns and carved tablets with warm solar yellow rim-glow (`0 0 16px rgba(235, 176, 45, 0.35)`) and diffused ground separation (`0 16px 36px rgba(34, 40, 49, 0.4)`).
- **Illumination Engine**: Highlights are powered by warm top-down sunlight (1px soft inner highlight: `inset 0 1px 0 rgba(255, 255, 255, 0.45)`) while bottom edges feature a subtle carved bevel shadow.

## Shapes

The shape vocabulary replicates river stones, chiseled megaliths, and smooth wooden totems:

- **Border Radius**: Baseline roundedness index `2` (8px / 0.5rem for standard buttons and inputs; 16px / 1rem for player panels and game cards; 24px / 1.5rem for large game boards and sanctuary shrines).
- **Contour & Stroke**: Elements feature subtle, deliberate, dark-slate perimeter strokes (1.5px to 2.5px of `#222831` at 70%–100% opacity) mimicking hand-inked Ghibli animation cels.
- **Runic Accents**: Corners of prominent stone panels feature engraved Celtic/Jomon-inspired runic notches or moss flourish cutouts.

## Components

### 1. Buttons & Dice Trays
- **Primary Roll Button**: Massive tactile stone/wood block styled with a raised 3D bevel. Top surface rendered in rich Moss Green (`#2E6F40`) or Solar Yellow (`#EBB02D`) during active turns. Emits a warm lantern pulse (`#EBB02D`) when ready to roll. Features an active click state that translates downward by 3px (`transform: translateY(3px)`), flattening the drop shadow to mimic physical compression.
- **Secondary Actions**: Chiseled parchment stone slabs (`#F4EEDD`) with slate borders and clean `label-lg` typography.

### 2. Ludo Board Tiles & Sacred Safe Zones
- **Standard Pathway Tiles**: Square stone slabs with rounded corners (4px radius), pale granite texture, and recessed grooved borders.
- **Quadrant Paths**: Tinted in high-luminance washes of Green, Crimson, Yellow, and Blue.
- **Sanctuary Stars / Safe Zones**: Inlaid brass or gold foil star glyphs set within the stone surface, accompanied by a soft pulsating amber glow to denote sanctuary from capture.

### 3. Player Dossiers & Turn Cards
- Designed as framed shrine plaques hung from mossy ropes.
- Active player plaque scales up 4% and activates a colored spirit wisp avatar that bobs gently with breathing animation.
- Includes turn countdown ring rendered as an unraveling braided shimenawa rope or draining glowing rune circle.

### 4. Chips, Badges & Rune Indicators
- **Spirit Badges**: Pill-shaped tablets with small etched forest spirit icons, indicating player status (e.g., "Ready", "AI Companion", "Sanctuary Ward").
- **Illuminated Runes**: Small square stone tokens set into the HUD that ignite with glowing colored sigils when special roll combinations or bonus moves are unlocked.

### 5. Dialogs, Modals & Victory Scrolls
- Unfurl as weathered parchment scrolls supported by polished dark cedar dowels.
- Text uses `headline-md` for ceremonial congratulations and `body-md` for match statistics, decorated with playful miniature forest spirit illustrations along the footer margins.