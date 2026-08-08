"""Chibi base model — animation clips for models/chibi-base.glb.

Run inside Blender after chibi_base.build():
    exec(open(r"<path>/chibi_anim.py").read()); build_animations(rig)

Poses are authored in WORLD axes (+X right, -Y forward, +Z up) and converted to
each bone's local space on the way in, because the rig mixes upright bones
(root/legs/torso/head, local Y up) with sideways ones (the hands, local Y along
±X). Authoring in bone space would mean a different mental model per bone.

A pose entry is {bone: {'l': (x, y, z) world offset, 'r': (rx, ry, rz) world
degrees}}. The rotation reads as (pitch, roll, yaw): rx tips the top forward, ry
tilts it sideways, rz turns it on the spot. Every bone the clip touches is keyed
on every keyframe, so a channel never drifts through a pose it was not authored
for.

Sign convention for pitch: a positive rx rotates the top of a bone forward and
its bottom backward, about the bone's own head. So the torso leans in at +rx and
the leg block trails behind the body at +rx.

No props: the hands are posed as if holding a bow, a greatsword or a dagger, but
nothing is modelled or parented. Weapons attach to hand.L / hand.R in game.
"""

import math

import bpy
from mathutils import Euler, Vector

FPS = 30

# rest offsets used by several clips
_HAND_FWD = -0.30      # a hand pushed a full arm's reach forward (-Y)
_STEP = 0.14           # walk stride, half of it either side of centre


def _clip(length, loop, keys):
    return {'length': length, 'loop': loop, 'keys': keys}


# --- locomotion ------------------------------------------------------------

IDLE = _clip(90, True, [
    (0,  {'root': {'l': (0, 0, 0)}, 'torso': {'r': (0, 0, 0)}, 'head': {'r': (0, 0, 0)},
          'hand.L': {'l': (0, 0, 0)}, 'hand.R': {'l': (0, 0, 0)}}),
    (30, {'root': {'l': (0, 0, -0.018)}, 'torso': {'r': (2, 0, 0)}, 'head': {'r': (-3, 0, 4)},
          'hand.L': {'l': (0.01, 0, -0.02)}, 'hand.R': {'l': (-0.01, 0, -0.02)}}),
    (60, {'root': {'l': (0, 0, 0.008)}, 'torso': {'r': (-1, 0, 0)}, 'head': {'r': (2, 0, -5)},
          'hand.L': {'l': (-0.01, 0, 0.015)}, 'hand.R': {'l': (0.01, 0, 0.015)}}),
    (90, {'root': {'l': (0, 0, 0)}, 'torso': {'r': (0, 0, 0)}, 'head': {'r': (0, 0, 0)},
          'hand.L': {'l': (0, 0, 0)}, 'hand.R': {'l': (0, 0, 0)}}),
])


def _step_pose(fwd, root_z, lean, yaw, lift_back):
    """One walk/run contact: `fwd` is how far foot.L leads (-Y), arms swing opposite."""
    return {
        'root':   {'l': (0, 0, root_z)},
        'legs':   {'r': (0, 0, 0)},
        'torso':  {'r': (lean, 0, yaw)},
        'head':   {'r': (-lean * 0.5, 0, -yaw)},
        'foot.L': {'l': (0, -fwd, 0.0), 'r': (-fwd * 40, 0, 0)},
        'foot.R': {'l': (0, fwd, lift_back), 'r': (fwd * 25, 0, 0)},
        'hand.L': {'l': (0, fwd * 0.8, -fwd * 0.3), 'r': (fwd * 60, 0, 0)},
        'hand.R': {'l': (0, -fwd * 0.8, fwd * 0.3), 'r': (-fwd * 60, 0, 0)},
    }


def _pass_pose(swing, root_z, lean):
    """Mid-stride: the trailing foot swings through under the body."""
    return {
        'root':   {'l': (0, 0, root_z)},
        'legs':   {'r': (0, 0, 0)},
        'torso':  {'r': (lean, 0, 0)},
        'head':   {'r': (-lean * 0.5, 0, 0)},
        'foot.L': {'l': (0, 0, 0.0), 'r': (0, 0, 0)},
        'foot.R': {'l': (0, 0, swing), 'r': (-15, 0, 0)},
        'hand.L': {'l': (0, 0, 0), 'r': (0, 0, 0)},
        'hand.R': {'l': (0, 0, 0), 'r': (0, 0, 0)},
    }


def _mirror(pose):
    """Swap the left/right halves of a stride pose and flip its x-facing terms."""
    out = {}
    for bone, ch in pose.items():
        target = bone.replace('.L', '.@').replace('.R', '.L').replace('.@', '.R')
        m = {}
        if 'l' in ch:
            m['l'] = (-ch['l'][0], ch['l'][1], ch['l'][2])
        if 'r' in ch:
            m['r'] = (ch['r'][0], -ch['r'][1], -ch['r'][2])
        out[target] = m
    return out


WALK = _clip(32, True, [
    (0,  _step_pose(_STEP, -0.020, 3, 4, 0.045)),
    (8,  _pass_pose(0.055, 0.012, 2)),
    (16, _mirror(_step_pose(_STEP, -0.020, 3, 4, 0.045))),
    (24, _mirror(_pass_pose(0.055, 0.012, 2))),
    (32, _step_pose(_STEP, -0.020, 3, 4, 0.045)),
])

RUN = _clip(22, True, [
    (0,  _step_pose(0.24, -0.035, 14, 6, 0.10)),
    (6,  _pass_pose(0.13, 0.055, 12)),        # airborne: the body is at its highest
    (11, _mirror(_step_pose(0.24, -0.035, 14, 6, 0.10))),
    (17, _mirror(_pass_pose(0.13, 0.055, 12))),
    (22, _step_pose(0.24, -0.035, 14, 6, 0.10)),
])

JUMP = _clip(42, False, [
    (0,  {'root': {'l': (0, 0, 0)}, 'legs': {'r': (0, 0, 0)}, 'torso': {'r': (0, 0, 0)},
          'head': {'r': (0, 0, 0)}, 'hand.L': {'l': (0, 0, 0), 'r': (0, 0, 0)},
          'hand.R': {'l': (0, 0, 0), 'r': (0, 0, 0)},
          'foot.L': {'l': (0, 0, 0), 'r': (0, 0, 0)}, 'foot.R': {'l': (0, 0, 0), 'r': (0, 0, 0)}}),
    (7,  {'root': {'l': (0, 0, -0.13)}, 'legs': {'r': (6, 0, 0)}, 'torso': {'r': (16, 0, 0)},
          'head': {'r': (-8, 0, 0)}, 'hand.L': {'l': (0, 0.10, -0.10), 'r': (-40, 0, 0)},
          'hand.R': {'l': (0, 0.10, -0.10), 'r': (-40, 0, 0)},
          'foot.L': {'l': (0, 0, 0), 'r': (0, 0, 0)}, 'foot.R': {'l': (0, 0, 0), 'r': (0, 0, 0)}}),
    (13, {'root': {'l': (0, 0, 0.30)}, 'legs': {'r': (-4, 0, 0)}, 'torso': {'r': (-8, 0, 0)},
          'head': {'r': (6, 0, 0)}, 'hand.L': {'l': (0.03, -0.06, 0.26), 'r': (70, 0, 0)},
          'hand.R': {'l': (-0.03, -0.06, 0.26), 'r': (70, 0, 0)},
          'foot.L': {'l': (0, 0.04, 0.05), 'r': (25, 0, 0)},
          'foot.R': {'l': (0, 0.04, 0.05), 'r': (25, 0, 0)}}),
    (22, {'root': {'l': (0, 0, 0.46)}, 'legs': {'r': (0, 0, 0)}, 'torso': {'r': (4, 0, 0)},
          'head': {'r': (-2, 0, 0)}, 'hand.L': {'l': (0.05, 0, 0.16), 'r': (30, 0, 0)},
          'hand.R': {'l': (-0.05, 0, 0.16), 'r': (30, 0, 0)},
          'foot.L': {'l': (0, -0.06, 0.03), 'r': (-15, 0, 0)},
          'foot.R': {'l': (0, 0.06, 0.03), 'r': (15, 0, 0)}}),
    (32, {'root': {'l': (0, 0, 0.14)}, 'legs': {'r': (-3, 0, 0)}, 'torso': {'r': (-6, 0, 0)},
          'head': {'r': (4, 0, 0)}, 'hand.L': {'l': (0.06, 0.04, -0.04), 'r': (-25, 0, 0)},
          'hand.R': {'l': (-0.06, 0.04, -0.04), 'r': (-25, 0, 0)},
          'foot.L': {'l': (0, -0.10, 0), 'r': (-25, 0, 0)},
          'foot.R': {'l': (0, -0.10, 0), 'r': (-25, 0, 0)}}),
    (38, {'root': {'l': (0, 0, -0.10)}, 'legs': {'r': (5, 0, 0)}, 'torso': {'r': (14, 0, 0)},
          'head': {'r': (-6, 0, 0)}, 'hand.L': {'l': (0.04, 0.08, -0.08), 'r': (-30, 0, 0)},
          'hand.R': {'l': (-0.04, 0.08, -0.08), 'r': (-30, 0, 0)},
          'foot.L': {'l': (0, 0, 0), 'r': (0, 0, 0)}, 'foot.R': {'l': (0, 0, 0), 'r': (0, 0, 0)}}),
    (42, {'root': {'l': (0, 0, 0)}, 'legs': {'r': (0, 0, 0)}, 'torso': {'r': (0, 0, 0)},
          'head': {'r': (0, 0, 0)}, 'hand.L': {'l': (0, 0, 0), 'r': (0, 0, 0)},
          'hand.R': {'l': (0, 0, 0), 'r': (0, 0, 0)},
          'foot.L': {'l': (0, 0, 0), 'r': (0, 0, 0)}, 'foot.R': {'l': (0, 0, 0), 'r': (0, 0, 0)}}),
])

# --- carried poses ---------------------------------------------------------

def _glide(sway, drift):
    """Hanging under a glider: both hands overhead on the bar, body streamlined."""
    return {
        'root':   {'l': (sway * 0.10, 0, drift)},
        'legs':   {'r': (20, 0, 0)},                        # legs trail behind
        'torso':  {'r': (26, sway * 5, 0)},                 # chest down the airflow
        'head':   {'r': (-34, 0, sway * 6)},                # eyes forward regardless
        # hands overhead on the bar, and high enough to clear the big head
        'hand.L': {'l': (-0.14, -0.04, 0.86), 'r': (0, 0, -75)},
        'hand.R': {'l': (0.14, -0.04, 0.86), 'r': (0, 0, 75)},
        'foot.L': {'l': (0, 0.16, 0.06), 'r': (30, 0, 0)},
        'foot.R': {'l': (0, 0.16, 0.06), 'r': (30, 0, 0)},
    }


GLIDE = _clip(90, True, [
    (0,  _glide(0.0, 0.0)),
    (30, _glide(1.0, 0.03)),
    (60, _glide(-1.0, -0.02)),
    (90, _glide(0.0, 0.0)),
])


def _ride(bob, lean):
    """Sitting a mount: thighs up and forward, feet out in the stirrups, hands
    low in front on the reins."""
    return {
        'root':   {'l': (0, 0, bob)},
        'legs':   {'r': (-38, 0, 0)},
        'torso':  {'r': (lean, 0, 0)},
        'head':   {'r': (-lean * 0.6, 0, 0)},
        'hand.L': {'l': (-0.06, -0.24, -0.06), 'r': (0, 0, -30)},
        'hand.R': {'l': (0.06, -0.24, -0.06), 'r': (0, 0, 30)},
        'foot.L': {'l': (0.07, -0.16, 0.20), 'r': (-20, 0, 12)},
        'foot.R': {'l': (-0.07, -0.16, 0.20), 'r': (-20, 0, -12)},
    }


RIDE = _clip(90, True, [
    (0,  _ride(0.0, 6)),
    (15, _ride(0.035, 2)),      # a trot beat, three to the cycle
    (30, _ride(0.0, 6)),
    (45, _ride(0.035, 2)),
    (60, _ride(0.0, 6)),
    (75, _ride(0.035, 2)),
    (90, _ride(0.0, 6)),
])

# --- attacks ---------------------------------------------------------------
# Every attack returns to rest on its last frame so it can blend back to Idle.

_REST = {'root': {'l': (0, 0, 0)}, 'legs': {'r': (0, 0, 0)}, 'torso': {'r': (0, 0, 0)},
         'head': {'r': (0, 0, 0)},
         'hand.L': {'l': (0, 0, 0), 'r': (0, 0, 0)}, 'hand.R': {'l': (0, 0, 0), 'r': (0, 0, 0)},
         'foot.L': {'l': (0, 0, 0), 'r': (0, 0, 0)}, 'foot.R': {'l': (0, 0, 0), 'r': (0, 0, 0)}}

MELEE = _clip(24, False, [
    (0,  _REST),
    (5,  {'torso': {'r': (-4, 0, 22)}, 'head': {'r': (0, 0, 10)},
          'hand.R': {'l': (0.02, 0.16, 0.04), 'r': (0, 0, -20)},
          'hand.L': {'l': (-0.04, -0.10, 0.06)}, 'legs': {'r': (0, 0, 8)}}),
    (10, {'torso': {'r': (8, 0, -30)}, 'head': {'r': (4, 0, -14)},
          'hand.R': {'l': (-0.14, -0.42, 0.02), 'r': (0, 0, 25)},
          'hand.L': {'l': (0.02, 0.14, -0.02)}, 'legs': {'r': (0, 0, -12)}}),
    (16, {'torso': {'r': (2, 0, -12)}, 'head': {'r': (0, 0, -4)},
          'hand.R': {'l': (-0.04, -0.16, 0.0)}, 'hand.L': {'l': (0, 0.04, 0)},
          'legs': {'r': (0, 0, -4)}}),
    (24, _REST),
])

BOW = _clip(48, False, [
    (0,  _REST),
    (12, {'torso': {'r': (0, 0, 30)}, 'head': {'r': (0, 0, -18)},
          'hand.L': {'l': (-0.10, _HAND_FWD, 0.10), 'r': (0, 0, -20)},
          'hand.R': {'l': (-0.06, -0.06, 0.12), 'r': (0, 0, 10)},
          'legs': {'r': (0, 0, 14)}, 'foot.L': {'l': (0, -0.05, 0)}}),
    (22, {'torso': {'r': (0, 0, 32)}, 'head': {'r': (0, 0, -20)},          # drawn
          'hand.L': {'l': (-0.10, _HAND_FWD, 0.10), 'r': (0, 0, -20)},
          'hand.R': {'l': (0.04, 0.20, 0.13), 'r': (0, 0, 30)},
          'legs': {'r': (0, 0, 14)}, 'foot.L': {'l': (0, -0.05, 0)}}),
    (30, {'torso': {'r': (0, 0, 32)}, 'head': {'r': (0, 0, -20)},          # hold
          'hand.L': {'l': (-0.10, _HAND_FWD, 0.10), 'r': (0, 0, -20)},
          'hand.R': {'l': (0.05, 0.22, 0.13), 'r': (0, 0, 30)},
          'legs': {'r': (0, 0, 14)}, 'foot.L': {'l': (0, -0.05, 0)}}),
    (34, {'torso': {'r': (-3, 0, 28)}, 'head': {'r': (0, 0, -20)},         # loose
          'hand.L': {'l': (-0.10, -0.26, 0.10), 'r': (0, 0, -14)},
          'hand.R': {'l': (0.10, 0.34, 0.16), 'r': (0, 0, 50)},
          'legs': {'r': (0, 0, 14)}, 'foot.L': {'l': (0, -0.05, 0)}}),
    (48, _REST),
])

GREATSWORD = _clip(48, False, [
    (0,  _REST),
    (14, {'root': {'l': (0, 0.04, 0)}, 'legs': {'r': (-6, 0, 0)},          # over the shoulder
          'torso': {'r': (-20, 0, 14)}, 'head': {'r': (10, 0, 6)},
          'hand.L': {'l': (0.02, 0.16, 0.44), 'r': (-45, 0, -30)},
          'hand.R': {'l': (-0.10, 0.20, 0.46), 'r': (-45, 0, 30)},
          'foot.L': {'l': (0, 0.06, 0)}, 'foot.R': {'l': (0, -0.06, 0)}}),
    (24, {'root': {'l': (0, -0.05, -0.05)}, 'legs': {'r': (8, 0, 0)},      # the cleave
          'torso': {'r': (26, 0, -10)}, 'head': {'r': (-12, 0, -4)},
          'hand.L': {'l': (0.0, -0.34, -0.30), 'r': (60, 0, 20)},
          'hand.R': {'l': (-0.02, -0.34, -0.30), 'r': (60, 0, -20)},
          'foot.L': {'l': (0, -0.10, 0)}, 'foot.R': {'l': (0, 0.08, 0)}}),
    (32, {'root': {'l': (0, -0.03, -0.02)}, 'legs': {'r': (5, 0, 0)},      # heavy recovery
          'torso': {'r': (18, 0, -6)}, 'head': {'r': (-8, 0, 0)},
          'hand.L': {'l': (0.0, -0.24, -0.22)}, 'hand.R': {'l': (-0.02, -0.24, -0.22)},
          'foot.L': {'l': (0, -0.06, 0)}, 'foot.R': {'l': (0, 0.04, 0)}}),
    (48, _REST),
])

SWORD = _clip(30, False, [
    (0,  _REST),
    (8,  {'torso': {'r': (-8, 0, 26)}, 'head': {'r': (2, 0, 10)},
          'hand.R': {'l': (0.06, 0.14, 0.30), 'r': (-40, 0, 30)},
          'hand.L': {'l': (-0.04, -0.06, -0.04)}, 'legs': {'r': (0, 0, 10)}}),
    (15, {'torso': {'r': (10, 0, -28)}, 'head': {'r': (-6, 0, -12)},       # diagonal slash
          'hand.R': {'l': (-0.34, -0.30, -0.18), 'r': (50, 0, -30)},
          'hand.L': {'l': (0.04, 0.10, 0.02)}, 'legs': {'r': (0, 0, -10)},
          'foot.L': {'l': (0, -0.08, 0)}}),
    (21, {'torso': {'r': (4, 0, -14)}, 'head': {'r': (-2, 0, -6)},
          'hand.R': {'l': (-0.18, -0.18, -0.08)}, 'hand.L': {'l': (0.02, 0.04, 0)},
          'legs': {'r': (0, 0, -4)}, 'foot.L': {'l': (0, -0.04, 0)}}),
    (30, _REST),
])

DAGGER = _clip(20, False, [
    (0,  _REST),
    (5,  {'torso': {'r': (-2, 0, 18)}, 'head': {'r': (0, 0, 6)},
          'hand.R': {'l': (0.04, 0.18, 0.06), 'r': (0, 0, -25)},
          'hand.L': {'l': (-0.02, -0.06, 0)}}),
    (9,  {'torso': {'r': (6, 0, -22)}, 'head': {'r': (2, 0, -10)},         # the stab
          'hand.R': {'l': (-0.10, -0.40, 0.0), 'r': (0, 0, 15)},
          'hand.L': {'l': (0.02, 0.10, 0)}, 'foot.L': {'l': (0, -0.06, 0)}}),
    (14, {'torso': {'r': (2, 0, -8)}, 'hand.R': {'l': (-0.04, -0.14, 0)},
          'hand.L': {'l': (0, 0.03, 0)}, 'foot.L': {'l': (0, -0.03, 0)}}),
    (20, _REST),
])

# --- reactions -------------------------------------------------------------

HIT = _clip(20, False, [
    (0,  _REST),
    (3,  {'root': {'l': (0, 0.09, 0)}, 'legs': {'r': (-8, 0, 0)},
          'torso': {'r': (-18, 0, 0)}, 'head': {'r': (-26, 0, 0)},
          'hand.L': {'l': (0.08, 0.12, 0.04), 'r': (-30, 0, 0)},
          'hand.R': {'l': (-0.08, 0.12, 0.04), 'r': (-30, 0, 0)},
          'foot.L': {'l': (0, 0.04, 0)}, 'foot.R': {'l': (0, 0.04, 0)}}),
    (9,  {'root': {'l': (0, 0.03, -0.03)}, 'legs': {'r': (4, 0, 0)},
          'torso': {'r': (8, 0, 0)}, 'head': {'r': (6, 0, 0)},
          'hand.L': {'l': (0.02, -0.04, -0.02)}, 'hand.R': {'l': (-0.02, -0.04, -0.02)},
          'foot.L': {'l': (0, 0.01, 0)}, 'foot.R': {'l': (0, 0.01, 0)}}),
    (20, _REST),
])

# Death tips the whole figure on the root bone, whose head sits on the ground, so
# the body rotates about the point it would actually pivot on as it goes down.
DEATH = _clip(66, False, [
    (0,  _REST),
    (8,  {'root': {'l': (0, 0.06, 0), 'r': (-12, 0, 0)}, 'legs': {'r': (-6, 0, 0)},
          'torso': {'r': (-14, 0, 0)}, 'head': {'r': (-20, 0, 0)},
          'hand.L': {'l': (0.06, 0.10, 0.02)}, 'hand.R': {'l': (-0.06, 0.10, 0.02)},
          'foot.L': {'l': (0, 0, 0)}, 'foot.R': {'l': (0, 0, 0)}}),
    (20, {'root': {'l': (0, 0.02, -0.10), 'r': (-30, 0, 0)}, 'legs': {'r': (14, 0, 0)},
          'torso': {'r': (18, 0, 0)}, 'head': {'r': (24, 0, 0)},          # knees give way
          'hand.L': {'l': (0.10, -0.04, -0.16), 'r': (0, 0, -30)},
          'hand.R': {'l': (-0.10, -0.04, -0.16), 'r': (0, 0, 30)},
          'foot.L': {'l': (0.03, 0.06, 0)}, 'foot.R': {'l': (-0.03, 0.06, 0)}}),
    (38, {'root': {'l': (0, 0.16, 0.02), 'r': (-78, 0, 0)}, 'legs': {'r': (24, 0, 0)},
          'torso': {'r': (-6, 0, 0)}, 'head': {'r': (-14, 0, 0)},
          'hand.L': {'l': (0.16, 0, -0.10), 'r': (0, 0, -50)},
          'hand.R': {'l': (-0.16, 0, -0.10), 'r': (0, 0, 50)},
          'foot.L': {'l': (0.05, -0.04, 0)}, 'foot.R': {'l': (-0.05, -0.04, 0)}}),
    (48, {'root': {'l': (0, 0.20, 0.0), 'r': (-88, 0, 0)}, 'legs': {'r': (16, 0, 0)},
          'torso': {'r': (-2, 0, 4)}, 'head': {'r': (-6, 10, 0)},          # settle, head lolls
          'hand.L': {'l': (0.20, 0.02, -0.06), 'r': (0, 0, -60)},
          'hand.R': {'l': (-0.20, 0.02, -0.06), 'r': (0, 0, 60)},
          'foot.L': {'l': (0.06, -0.06, 0)}, 'foot.R': {'l': (-0.06, -0.06, 0)}}),
    (66, {'root': {'l': (0, 0.20, 0.0), 'r': (-90, 0, 0)}, 'legs': {'r': (16, 0, 0)},
          'torso': {'r': (-2, 0, 4)}, 'head': {'r': (-6, 10, 0)},          # hold on the ground
          'hand.L': {'l': (0.20, 0.02, -0.06), 'r': (0, 0, -60)},
          'hand.R': {'l': (-0.20, 0.02, -0.06), 'r': (0, 0, 60)},
          'foot.L': {'l': (0.06, -0.06, 0)}, 'foot.R': {'l': (-0.06, -0.06, 0)}}),
])

CLIPS = {
    'Idle': IDLE,
    'Walk': WALK,
    'Run': RUN,
    'Jump': JUMP,
    'Glide': GLIDE,
    'Ride': RIDE,
    'MeleeAttack': MELEE,
    'BowAttack': BOW,
    'GreatSwordAttack': GREATSWORD,
    'SwordAttack': SWORD,
    'DaggerAttack': DAGGER,
    'Hit': HIT,
    'Death': DEATH,
}


def _to_local(pose_bone, channel):
    """World-space pose -> bone-space location + quaternion.

    The bone's rest basis M maps bone axes onto world axes, so a world rotation R
    becomes M^-1 R M in bone space, and a world offset becomes M^-1 v.
    """
    basis = pose_bone.bone.matrix_local.to_3x3()
    inv = basis.inverted()
    loc = inv @ Vector(channel.get('l', (0, 0, 0)))
    rot = Euler([math.radians(a) for a in channel.get('r', (0, 0, 0))], 'XYZ').to_matrix()
    return loc, (inv @ rot @ basis).to_quaternion()


def _fcurves(action):
    """Blender 4.4+ keeps fcurves under layers/strips/channelbags, not on the action."""
    if hasattr(action, 'fcurves'):
        return list(action.fcurves)
    out = []
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                out += list(bag.fcurves)
    return out


def build_animations(rig, clips=CLIPS):
    bpy.context.scene.render.fps = FPS
    if rig.animation_data is None:
        rig.animation_data_create()
    for track in list(rig.animation_data.nla_tracks):
        rig.animation_data.nla_tracks.remove(track)
    for act in [a for a in bpy.data.actions]:
        bpy.data.actions.remove(act)
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'

    built = {}
    for name, clip in clips.items():
        # every bone the clip touches is keyed on every keyframe - a channel that
        # appears in one pose only would otherwise interpolate from wherever it was
        bones = sorted({b for _, pose in clip['keys'] for b in pose})
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        rig.animation_data.action = action
        if hasattr(action, 'slots'):                 # Blender 4.4+ slotted actions
            slot = action.slots.new(id_type='OBJECT', name=rig.name)
            rig.animation_data.action_slot = slot

        for frame, pose in clip['keys']:
            for bone in bones:
                pb = rig.pose.bones[bone]
                loc, quat = _to_local(pb, pose.get(bone, {}))
                pb.location, pb.rotation_quaternion = loc, quat
                pb.keyframe_insert('location', frame=frame)
                pb.keyframe_insert('rotation_quaternion', frame=frame)

        for fc in _fcurves(action):
            for kp in fc.keyframe_points:
                kp.interpolation = 'BEZIER'
        # stash muted, so every clip is exported yet none drives the rest pose
        strip = rig.animation_data.nla_tracks.new().strips.new(name, 0, action)
        strip.name = name
        rig.animation_data.nla_tracks[-1].name = name
        rig.animation_data.nla_tracks[-1].mute = True
        rig.animation_data.action = None
        built[name] = (clip['length'], clip['loop'])

    for pb in rig.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)
    return built
