# Art

## Official owl

`public/img/owl.png` is the Addwize owl from the client deck (*ADDWIZE FOCUS CHALLENGE.pdf*, slide 2),
cut out on a transparent background. It's the official mascot: brown head and ear tufts, big amber
eyes, white chest feathers, purple-tipped wings, orange feet, 3D "animated film" render.

| File | Size | Used for |
|---|---|---|
| `public/img/owl.png` | 437×584 | Attract screen, result screen, registration, admin, the owl hidden in the game |
| `public/img/owl-512.png` | 512×512 | Square version, transparent |
| `public/img/apple-touch-icon.png` | 180×180 | iPad home-screen icon (deck gradient behind the owl) |
| `public/img/favicon-64.png` | 64×64 | Browser tab |

**Resolution limit:** the deck's images are flattened 1672×941 renders, so this is the largest
clean owl that exists in it. It's sharp up to about 450 px wide on screen. For anything bigger
(stand graphics, print, a full-screen hero), ask The Bro Media for the original render or the
model/prompt they used. They generated it, so they can export it at 4K on a transparent background.

## Game scenes (still needed)

The deck shows two scenes only as small mockups on a screen in perspective (slides 5 and 8). They
can't be used as game backgrounds. Until real scenes arrive, the game builds a random cluttered
field with the official owl hidden in it.

Spec for each scene (6–10 recommended, so returning players can't memorise positions):

- **1080×1920 portrait** (the touch screen), PNG or high-quality JPG, at least 2160×3840 if possible
- The **same owl** as above, small (about 4–6% of the width) and partly hidden but fair: it must be
  findable in under 10 s by an attentive person
- Exactly **one** owl per scene, with no other owls, owl toys or owl prints as decoys
- No text, logos or brand names inside the illustration
- No medical procedures or anything that reads as a diagnostic test (the stand is entertainment)

Prompt that matches the deck's look (swap the setting per scene):

> Vertical 9:16 "find the hidden character" illustration, extremely busy and colourful, Pixar-style
> 3D render, warm cinematic lighting, purple and orange accents. Setting: **{a cozy school library /
> a busy science fair / a crowded city park / a kids' classroom at the end of the day / a toy store /
> a train station / a museum hall / a garden picnic}**, full of people, books, toys, papers,
> backpacks, plants and small details at every scale. Hidden somewhere off-centre, small and partly
> tucked behind objects: one cute cartoon owl with brown head and ear tufts, big amber eyes, white
> chest feathers, purple-tipped wings and orange feet (use the attached owl as the exact reference).
> No text, no logos, no other owls.

Attach `public/img/owl.png` as the character reference so every scene uses the same owl.

**Loading them:** drop the files in `public/scenes/`, then go to Admin → **Escenas**, tap the owl
in each scene, adjust the circle, mark it *Activa* and save (see README).
