"""Export the OPEN .blend to the .glb beside it.

Headless, and it is what the watcher in tools/blend-glb.mjs runs:

    blender --background models/chibi-base.blend --python models/export_glb.py

IT DOES NOT REBUILD, AND THAT IS THE WHOLE POINT. The command in README.md
re-runs `build()` and `build_animations()`, which replace the mesh, the rig and
every action FROM the scripts and throw away whatever the file held. This
exports the file AS SAVED — move a vertex by hand, save, and the .glb carries
that vertex. A "save the .blend and the .glb follows" loop cannot mean anything
else.

The glTF flags are not restated here. `export()` in chibi_base.py owns them, so
a manual export and an automatic one cannot come to different conclusions about
(for instance) whether the stashed NLA actions ship.

Objects are found BY TYPE rather than by name: one mesh, one armature. The two
in this file happen to be ChibiBase and ChibiRig, but a second .blend dropped in
beside it should export without editing this. A file with no armature is not
handled — `export()` selects one — and says so rather than writing half a model.
"""

import os
import sys

import bpy

blend = bpy.data.filepath
if not blend:
    sys.exit('export_glb: no .blend open. '
             'Run it as: blender --background <file>.blend --python models/export_glb.py')

out = os.path.splitext(blend)[0] + '.glb'
here = os.path.dirname(os.path.abspath(__file__))

ns = {'__name__': 'chibi_base'}
with open(os.path.join(here, 'chibi_base.py'), encoding='utf-8') as f:
    # Top level only: the module defines constants and functions and builds
    # nothing on import, which is what makes borrowing `export` from it safe.
    exec(f.read(), ns)

mesh = next((o for o in bpy.data.objects if o.type == 'MESH'), None)
rig = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if mesh is None or rig is None:
    sys.exit(f'export_glb: {os.path.basename(blend)} has no mesh + armature pair to export')

ns['export'](mesh, rig, out)
print(f'export_glb: wrote {out}')
