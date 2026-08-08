"""Chibi base model — generator for models/chibi-base.glb.

Run inside Blender:  exec(open(r"<path>/chibi_base.py").read())

The figure is one mesh with rigid, mutually exclusive vertex groups — one group
per bone, weight 1.0 — so every part is a solid block that animates freely:
torso, head, the merged leg block, and four free-floating extremities.
No arms, no legs, no neck.
"""

import bpy
import bmesh
from mathutils import Vector

# --- proportions -----------------------------------------------------------
# Total height 1.75. The head is 0.78 of it (45%) and 0.92 wide against a
# 0.80-wide torso: enough overhang to read as chibi, little enough that the
# hands (out to x 0.76) still clear it from the front.
#
# box = (x0, x1, y0, y1, z0, z1, shape)
#   shape = None                       plain block
#         | ('voxel', (nx,ny,nz), fn)  cell grid; fn(i,j,k,n) says which cells are solid
#
# A voxel part is emitted as a single welded shell, so two blocks of one part can
# never leave a coplanar face pair behind - which is what merged boxes would do
# wherever a step changes width.


def stepped_ball(i, j, k, n):
    """A CUBE WITH ONE STEP RAISED ON EACH OF ITS SIX FACES — the blockiest
    shape that still reads as a ball.

    On the 5^3 grid that is a solid 3^3 core plus a 3x3 plate on each face:
    81 of the 125 cells, against the 93 of the distance-field sphere this
    replaced. What goes is every cell with TWO or three coordinates out at the
    rim — the twelve edges and the eight corners — and that is the whole
    difference. Those cells are what rounded the silhouette off into a blob;
    without them the outline is a plain plus from any face-on view and a
    three-step stair from any corner, which is how a low-resolution sphere is
    drawn by hand and what a chibi mitt wants.

    THE GRID STAYS AT 5, and it has to: a cube plus one step is 1 + 3 + 1 cells
    across by definition, so 5 is the coarsest grid the shape fits on. Bigger
    cells than this means giving up the step and taking a plain cube.

    The old helper took a squared radius (8.0 for the hands, where 6 collapsed
    to a plus and 9 left a nicked cube). It is gone rather than kept for one
    caller: this is the only rounded part on the figure.
    """
    h = [(d - 1) / 2.0 for d in n]
    rim = sum(1 for a, c in enumerate((i, j, k)) if abs(c - h[a]) >= h[a] - 1e-9)
    return rim <= 1


def boot(i, j, k, n):
    """Blocky boot on a 5 x 6 x 3 grid, toe at j = 0 (-Y). Three height steps -
    a sole, an instep and an ankle - which ramps up from toe to heel the way a
    pixel-art boot does, without shredding into a staircase:
      k = 2 (ankle)        from the middle back
      k = 0, 1 (foot)      everything, minus the outer columns at the toe tip so
                           the nose rounds off in plan view. Both layers, or the
                           tip thins into a flap instead of a toe cap.
    """
    nx, ny, _ = n
    if k == 2:
        return j >= ny // 2
    return 0 < i < nx - 1 if j == 0 else True


PARTS = {
    'head':   ([(-0.46, 0.46, -0.44, 0.44, 0.97, 1.75, None)], 'head'),
    'torso':  ([(-0.40, 0.40, -0.28, 0.28, 0.52, 1.02, None)], 'torso'),
    # one rigid block of merged boxes: hip slab sunk under the torso, two stubs
    'legs':   ([(-0.42, 0.42, -0.30, 0.30, 0.34, 0.55, None),
                (0.06, 0.40, -0.28, 0.28, 0.24, 0.38, None),
                (-0.40, -0.06, -0.28, 0.28, 0.24, 0.38, None)], 'legs'),
    'hand.L': ([(0.44, 0.76, -0.16, 0.16, 0.59, 0.91, ('voxel', (5, 5, 5), stepped_ball))], 'hand.L'),
    'hand.R': ([(-0.76, -0.44, -0.16, 0.16, 0.59, 0.91, ('voxel', (5, 5, 5), stepped_ball))], 'hand.R'),
    # the boot mask is symmetric in x, so the same grid serves both feet
    'foot.L': ([(0.05, 0.42, -0.30, 0.16, 0.00, 0.20, ('voxel', (5, 6, 3), boot))], 'foot.L'),
    'foot.R': ([(-0.42, -0.05, -0.30, 0.16, 0.00, 0.20, ('voxel', (5, 6, 3), boot))], 'foot.R'),
}

# Boxes of neighbouring parts overlap on purpose (the seam is hidden inside the
# body), so a vertex is claimed by the FIRST part here that contains it. Islands
# first, then the torso — it owns the planes it shares with the head and the hips.
PRIORITY = ['hand.L', 'hand.R', 'foot.L', 'foot.R', 'torso', 'head', 'legs']

# Drop the head's bottom skirt into the torso: a head tilt never opens a neck hole.
SINK = {'head': (0.97, 0.92)}

# --- palette ---------------------------------------------------------------
# ONE MATERIAL PER PART, AND ALL OF THEM WHITE. This is a proportion study, not
# a costume: it used to carry three materials (skin / cloth / shoe) in the
# game's own colours, and a coloured model argues about the wrong thing — the
# eye reads the outfit instead of the silhouette, and the two parts that share
# a colour (the head and the hands were both `skin`) stop being separable at
# exactly the joints this file exists to place.
#
# So every part is its own tinted white: seven hues spread round the wheel, and
# NO CHANNEL BELOW 0.80 linear on any of them, which is what keeps the whole
# figure reading as white rather than as a costume. The first cut of this held
# every channel inside 0.85..0.97 — a spread of 0.08 — and under the viewport's
# own studio light that is not a palette, it is one white with rounding error.
# 0.16 or so between a swatch's high and low channel is the floor for telling
# two parts apart across a room; the value stays up, so it is still white.
#
# LEFT IS WARM, RIGHT IS COOL, and that pairing is worth more than it looks.
# The figure faces -Y, so his right is at -x — which the game rig had backwards
# for a long time, with every "right" in the animator naming his left (see the
# note at the end of models/README.md). A warm hand and a cool hand say which
# is which from any angle, with no gizmo and no axis to remember.
MATERIALS = [('head',   (0.99, 0.95, 0.84)),   # ivory — the reference value
             ('torso',  (0.74, 0.83, 0.99)),   # pale blue, the biggest mass
             ('legs',   (0.78, 0.96, 0.80)),   # pale green, against the torso above it
             ('hand.L', (0.99, 0.84, 0.72)),   # peach  — left, warm
             ('hand.R', (0.72, 0.95, 0.99)),   # cyan   — right, cool
             ('foot.L', (0.99, 0.78, 0.84)),   # rose   — left, warm
             ('foot.R', (0.84, 0.78, 0.99))]   # lilac  — right, cool

BONES = [
    # name,     head,                 tail,                  parent
    ('root',   (0, 0, 0.00),         (0, 0, 0.14),           None),
    ('legs',   (0, 0, 0.40),         (0, 0, 0.58),           'root'),   # hip pivot inside the slab
    ('torso',  (0, 0, 0.55),         (0, 0, 1.02),           'legs'),
    ('head',   (0, 0, 1.00),         (0, 0, 1.75),           'torso'),  # pivot inside the sunk skirt
    ('hand.L', (0.46, 0, 0.75),      (0.76, 0, 0.75),        'torso'),  # pivot on the inboard face
    ('hand.R', (-0.46, 0, 0.75),     (-0.76, 0, 0.75),       'torso'),
    ('foot.L', (0.23, 0.08, 0.10),   (0.23, -0.24, 0.10),    'legs'),   # ankle over the heel, toe -Y
    ('foot.R', (-0.23, 0.08, 0.10),  (-0.23, -0.24, 0.10),   'legs'),
]

EPS = 1e-5
BOX_FACES = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
# neighbour offset -> the cube corner loop facing that way
CELL_FACES = [((-1, 0, 0), (0, 3, 7, 4)), ((1, 0, 0), (1, 5, 6, 2)),
              ((0, -1, 0), (0, 4, 5, 1)), ((0, 1, 0), (3, 2, 6, 7)),
              ((0, 0, -1), (0, 1, 2, 3)), ((0, 0, 1), (4, 7, 6, 5))]


def _inside(p, boxes):
    return any(b[0] - EPS <= p.x <= b[1] + EPS and b[2] - EPS <= p.y <= b[3] + EPS
               and b[4] - EPS <= p.z <= b[5] + EPS for b in (bx[:6] for bx in boxes))


def _add_block(bm, x0, x1, y0, y1, z0, z1):
    vs = [bm.verts.new(c) for c in [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                    (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]]
    return [bm.faces.new([vs[i] for i in f]) for f in BOX_FACES]


def _add_voxels(bm, x0, x1, y0, y1, z0, z1, n, solid):
    """Emit only the shell: a face is built where the neighbouring cell is empty,
    and corners are welded, so there is no interior geometry to z-fight."""
    nx, ny, nz = n
    step = ((x1 - x0) / nx, (y1 - y0) / ny, (z1 - z0) / nz)
    filled = {(i, j, k) for i in range(nx) for j in range(ny) for k in range(nz)
              if solid(i, j, k, n)}
    cache = {}

    def vert(gi, gj, gk):
        key = (gi, gj, gk)
        if key not in cache:
            cache[key] = bm.verts.new((x0 + gi * step[0], y0 + gj * step[1], z0 + gk * step[2]))
        return cache[key]

    for (i, j, k) in filled:
        corners = [(i, j, k), (i + 1, j, k), (i + 1, j + 1, k), (i, j + 1, k),
                   (i, j, k + 1), (i + 1, j, k + 1), (i + 1, j + 1, k + 1), (i, j + 1, k + 1)]
        for offset, loop in CELL_FACES:
            if (i + offset[0], j + offset[1], k + offset[2]) not in filled:
                bm.faces.new([vert(*corners[c]) for c in loop])


def paint(obj):
    """(Re)build the material slots and hand every face to its part's swatch.

    SPLIT OUT OF `build` SO THE OPEN FILE CAN BE RECOLOURED WITHOUT REBUILDING
    IT. Re-running the generator replaces the mesh, the rig and all thirteen
    actions (see models/README.md), and a palette change is not a reason to
    lose a pose somebody is looking at. `build` calls this; so can a session:

        exec(open(r"models/chibi_base.py").read()); paint(bpy.data.objects['ChibiBase'])

    Faces are claimed in PRIORITY order, exactly as vertices are, so a face on
    a plane two parts share ends up with the same owner its vertices have.

    ONE FACE IS MIS-CLAIMED WHEN THIS IS RUN ON A BUILT FILE rather than mid-
    build, and it is worth knowing rather than fixing: `SINK` has by then pulled
    the head's bottom skirt down to 0.92, below the head's own box, so that face
    falls through to the torso. It is the underside of the head, buried inside
    the torso, and there is nothing there to look at.
    """
    mesh = obj.data
    mesh.materials.clear()
    for name, col in MATERIALS:
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*col, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.85
        mesh.materials.append(m)
    index = {name: i for i, (name, _) in enumerate(MATERIALS)}
    for poly in mesh.polygons:
        poly.use_smooth = False          # every part stays faceted
        for n in PRIORITY:
            if _inside(poly.center, PARTS[n][0]):
                poly.material_index = index[PARTS[n][1]]
                break
    return index


def build():
    for o in list(bpy.data.objects):
        if o.type in {'MESH', 'ARMATURE'}:
            bpy.data.objects.remove(o, do_unlink=True)

    bm = bmesh.new()
    for boxes, _ in PARTS.values():
        for x0, x1, y0, y1, z0, z1, shape in boxes:
            if shape and shape[0] == 'voxel':
                _add_voxels(bm, x0, x1, y0, y1, z0, z1, shape[1], shape[2])
            else:
                _add_block(bm, x0, x1, y0, y1, z0, z1)
    bm.normal_update()
    mesh = bpy.data.meshes.new('ChibiBase')
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new('ChibiBase', mesh)
    bpy.context.collection.objects.link(obj)

    paint(obj)

    groups = {n: obj.vertex_groups.new(name=n) for n in PARTS}
    assign = {}
    for v in mesh.vertices:
        assign[v.index] = next(n for n in PRIORITY if _inside(v.co, PARTS[n][0]))
        groups[assign[v.index]].add([v.index], 1.0, 'REPLACE')
    for v in mesh.vertices:
        n = assign[v.index]
        if n in SINK and abs(v.co.z - SINK[n][0]) < EPS:
            v.co.z = SINK[n][1]

    arm = bpy.data.armatures.new('ChibiRig')
    rig = bpy.data.objects.new('ChibiRig', arm)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, head, tail, parent in BONES:
        b = arm.edit_bones.new(name)
        b.head, b.tail = Vector(head), Vector(tail)
        b.use_connect = False            # every part rotates on its own pivot
        if parent:
            b.parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')

    obj.parent = rig
    obj.matrix_parent_inverse = rig.matrix_world.inverted()
    obj.modifiers.new('Armature', 'ARMATURE').object = rig

    counts = {}
    for a in assign.values():
        counts[a] = counts.get(a, 0) + 1
    return obj, rig, counts


def export(obj, rig, path):
    bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    obj.data.name = 'ChibiBase'
    for o in bpy.data.objects:
        o.select_set(False)
    obj.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB',
                              use_selection=True, export_apply=True,
                              # one glTF animation per action, whatever the NLA is
                              # doing, so the stashed clips all ship
                              export_animations=True, export_animation_mode='ACTIONS',
                              export_nla_strips=False, export_bake_animation=False,
                              export_optimize_animation_size=False)
