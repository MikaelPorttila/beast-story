# models/ — Blender source

The drawing the hero is built FROM. **Nothing here is loaded by the game**: the
renderer generates everything it draws (see AGENTS.md), so these files exist to
be opened, looked at and argued with — not shipped.

| File | What it is |
| --- | --- |
| `chibi-base.blend` | The source. Mesh, 8-bone rig, 13 actions. Blender 5.2 LTS. |
| `chibi_base.py` | Builds the figure and the rig from scratch |
| `chibi_anim.py` | Builds the 13 clips on that rig |
| `chibi-base.glb` | What the two scripts export |

`.blend1` (Blender's own backup) is gitignored; the `.blend` is not. It is
156 KB of binary, so every save is a new blob in the history — save it when the
model changes, not to record a camera move.

## Rebuilding

Everything in the two scripts is data at the top and one build function
underneath, so a proportion is a number to change and not a model to re-sculpt.
Re-running them **replaces** the mesh, the rig and every action:

```bash
blender --background --python-expr "import bpy; d='models/'; ns={}; exec(open(d+'chibi_base.py').read(), ns); o,r,c=ns['build'](); a={}; exec(open(d+'chibi_anim.py').read(), a); a['build_animations'](r); ns['export'](o,r,d+'chibi-base.glb'); bpy.ops.wm.save_as_mainfile(filepath=d+'chibi-base.blend')"
```

Open the result with `blender models/chibi-base.blend`. The clips are stashed as
muted NLA tracks, one per action — see the Action Editor, or the notes at the
top of `chibi_anim.py` for how the poses are authored.

## What it decides, and what it does not

The model is the argument for the SILHOUETTE: a head 46% of the figure, no arms,
no legs, no neck, hands and boots floating free, and one merged block of hip and
thigh. `src/player/hero-rig.ts` implements that in voxels, and the two are
allowed to drift — the game's hero has since grown a back holster, lost a
shield and had his hands resized against the weapons he holds. When they
disagree about a PROPORTION, this file is the intent.

**Sides:** the Blender figure faces -Y with +Z up, so his right is at -x, which
is where `hand.R` and `foot.R` are. That is worth knowing because the game rig
had it backwards for a long time — `armR` sat on the +x side and every "right"
in the animator was his left. Whichever file you are in, check the axis before
trusting a name.
