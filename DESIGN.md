# Session Replay Dashboard Design

## Style baseline
- Reference language: cinematic dark operations console with stronger readability guardrails
- Goal: keep the replay page dramatic, but make long logs, error diagnosis, and tool inspection easier to scan

## Tokens
- Background: `#07101d`
- Surface: `rgba(5, 14, 24, 0.78)`
- Surface elevated: `rgba(9, 20, 34, 0.9)`
- Border: `rgba(123, 160, 214, 0.22)`
- Text primary: `#edf3ff`
- Text secondary: `#a8bbdc`
- Accent blue: `#63b3ff`
- Accent green: `#42d392`
- Accent orange: `#ffb454`
- Accent red: `#ff6b81`
- Accent purple: `#b084ff`
- Radius: `14px` for cards, `999px` for badges
- Shadow: `0 18px 48px rgba(0, 0, 0, 0.28)`
- Blur: `blur(10px)` for key surfaces

## Layout rules
- Top area: overview banner + diagnosis first, metrics second
- Main body: left timeline, right contextual inspector/details
- Footer tabs: graph, errors, file changes, raw json

## Component rules
- Timeline filters use clickable count badges
- Every timeline item must expose status color and explicit status badge
- Error content should prefer human summary first, raw JSON second
- Tool events should render a dedicated inspector with copy actions
- Empty states should explain likely reasons, not only show zero-state text

## Accessibility basics
- Maintain high contrast on text-heavy blocks
- Focus/active states use visible blue ring
- Long JSON/log areas must have bounded height with internal scroll
