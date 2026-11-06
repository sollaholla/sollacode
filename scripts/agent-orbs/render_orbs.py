#!/usr/bin/env python3
"""Renders the agent orbs: galaxies sealed in a glass sphere.

Light is traced through 3D gas inside a refracting ball, so depth, dark lanes
and glow come from the volume itself. Each orb is a set of stacked images:
  deep   the gas, opaque
  dust   stars and sparks at their real depths, transparent
  glass  rim, reflections and shading, transparent, never moves
Lighting lives only in `glass`, so turning the inside never turns the light.

  python3 scripts/agent-orbs/render_orbs.py <out dir> [--size 384] [--only a,b]
Needs numpy, scipy and Pillow. Output is deterministic per orb seed.
"""
import argparse
import math
import os
import pathlib

import numpy as np
from PIL import Image
from scipy.fft import irfftn, rfftn
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.special import erf

from orbs import ORBS

IOR = 1.45


def clamp(x, a=0.0, b=1.0):
    return np.minimum(np.maximum(x, a), b)


def smooth(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3 - 2 * t)


def hexrgb(value):
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)], dtype=np.float32) ** 2.2


def ramp(t, stops):
    """Colors spread evenly along 0..1, in linear light."""
    colors = np.stack([hexrgb(s) for s in stops])
    xs = np.linspace(0, 1, len(stops))
    return np.stack([np.interp(t, xs, colors[:, c]) for c in range(3)], axis=-1).astype(np.float32)


def spectral(rng, n, beta):
    """Fractal noise from its power spectrum, uniform over 0..1, tiling in 3D."""
    white = rng.standard_normal((n, n, n)).astype(np.float32)
    k = np.fft.fftfreq(n).astype(np.float32) * n
    kz = np.fft.rfftfreq(n).astype(np.float32) * n
    radius = np.sqrt(k[:, None, None] ** 2 + k[None, :, None] ** 2 + kz[None, None, :] ** 2)
    radius[0, 0, 0] = 1
    field = irfftn(rfftn(white) * radius ** (-beta / 2), s=(n, n, n)).astype(np.float32)
    field = (field - field.mean()) / field.std()
    return (0.5 * (1 + erf(field / math.sqrt(2)))).astype(np.float32)


class Fields:
    def __init__(self, rng):
        self.soft = spectral(rng, 96, 4.7)
        self.big = spectral(rng, 128, 3.5)
        self.warp = [spectral(rng, 64, 4.6) for _ in range(3)]

    @staticmethod
    def at(volume, p, scale, shift=0.0):
        n = volume.shape[0]
        c = (p * (scale * 0.5) + (0.5 + shift)) * n
        return map_coordinates(volume, [c[:, 0], c[:, 1], c[:, 2]], order=1, mode="grid-wrap")

    def warped(self, p, amount, scale=0.8):
        w = np.stack([self.at(v, p, scale) - 0.5 for v in self.warp], axis=-1)
        return p + w * amount


# ---------------------------------------------------------------------------
# What fills each orb: light given off and light swallowed at a point.


def nebula(f, p, c):
    q = f.warped(p, c.get("warp", 1.5), 0.55)
    a = f.at(f.soft, q, 0.62)
    b = f.at(f.big, q, 0.8, 0.13)
    ridge = (1 - np.abs(2 * f.at(f.soft, q, 0.95, 0.41) - 1)) ** 16
    wisp = (1 - np.abs(2 * f.at(f.big, q, 1.0, 0.27) - 1)) ** 14
    lanes = smooth(0.5, 0.68, f.at(f.big, q, 0.95, 0.62))
    cx, cy, cz = c.get("focus", (0.12, -0.1, 0.0))
    d2 = (p[:, 0] - cx) ** 2 + (p[:, 1] - cy) ** 2 + (p[:, 2] - cz) ** 2
    focus = np.exp(-d2 / c.get("spread", 0.3))
    body = smooth(0.46, 0.92, 0.72 * a + 0.28 * b)
    temp = clamp(0.1 + 0.82 * focus * (0.45 + 0.8 * a) + 0.28 * ridge * focus)
    glow = body**1.8 * (0.16 + 1.9 * focus) + ridge * (0.5 + 2.6 * focus) + wisp * body * (0.2 + 1.1 * focus)
    emission = ramp(temp, c["ramp"]) * glow[:, None] * c.get("gain", 1.0)
    emission += hexrgb(c["ramp"][1]) * (0.012 + 0.05 * a * a)[:, None]
    return emission, 0.12 + lanes * 12.0 * (0.3 + focus)


def vortex(f, p, c):
    n = disc_normal(c)
    n /= np.linalg.norm(n)
    e1 = np.cross(n, (0.0, 1.0, 0.0)).astype(np.float32)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    q = f.warped(p, 0.12, 0.8)
    h, u, v = q @ n, q @ e1, q @ e2
    rho = np.sqrt(u * u + v * v) + 1e-4
    phi = np.arctan2(v, u)
    soft = f.at(f.soft, q, 1.1)
    grain = f.at(f.big, q, 1.9)
    arms, twist = c.get("arms", 2), c.get("twist", 3.4)
    spiral = phi - twist * np.log(rho + 0.03)
    wobble = (soft - 0.5) * 2.6
    band = (0.5 + 0.5 * np.cos(arms * spiral + wobble)) ** c.get("tight", 1.6)
    strands = np.zeros_like(band)
    for count, weight, power in ((7, 1.0, 10), (13, 0.8, 16), (23, 0.55, 22)):
        strands += weight * (0.5 + 0.5 * np.cos(count * spiral + wobble * 1.6 + grain * 2)) ** power
    plate = np.exp(-((h / (0.035 + 0.1 * rho)) ** 2))
    reach = smooth(0.0, 0.16, rho) * (1 - smooth(0.74, 1.02, rho))
    hole = c.get("hole", 0.0)
    if hole:
        reach = reach * smooth(hole * 0.9, hole * 1.7, rho)
    density = plate * reach * band
    temp = clamp(1.02 - rho * 1.1 + 0.22 * (soft - 0.5))
    glow = density * (0.22 + strands * 2.6 + grain**3 * 1.1) * 1.3
    emission = ramp(temp, c["ramp"]) * glow[:, None] * c.get("gain", 1.0)
    bulge = np.exp(-((np.sqrt(rho * rho + (h * 1.4) ** 2) / c.get("bulge", 0.13)) ** 2))
    if hole:
        ring = np.exp(-(((rho - hole * 1.6) / 0.016) ** 2)) * np.exp(-((h / 0.03) ** 2))
        emission += hexrgb(c["ramp"][-1]) * (ring * 4.5)[:, None]
    else:
        emission += np.array([1.0, 0.88, 0.7], dtype=np.float32) * (bulge * 3.2)[:, None]
    emission += hexrgb(c["ramp"][1]) * (plate * (1 - smooth(0.3, 1.0, rho)) * 0.05)[:, None]
    emission += hexrgb(c["ramp"][0]) * (0.02 + 0.05 * soft * soft)[:, None]
    lanes = plate * reach * (1 - band)
    return emission, 0.06 + lanes * 9


def burst(f, p, c):
    cx, cy, cz = c.get("focus", (0.05, 0.02, 0.0))
    o = p - np.array([cx, cy, cz], dtype=np.float32)
    r = np.sqrt((o * o).sum(axis=1)) + 1e-4
    u = o / r[:, None]
    q = f.warped(p, 1.0, 0.5)
    soft = f.at(f.soft, q, 0.7)
    veil = np.exp(-(((soft - 0.5) / 0.03) ** 2))
    veil2 = np.exp(-(((f.at(f.soft, q, 1.0, 0.3) - 0.5) / 0.022) ** 2))
    rays = f.at(f.big, u * 1.3, 1.0, 0.2) ** 9 * 60
    near = np.exp(-r / 0.3)
    temp = clamp(0.96 - r * 1.05 + 0.32 * (f.at(f.soft, q, 0.8, 0.5) - 0.5))
    color = ramp(temp, c["ramp"])
    glow = (veil * 1.0 + veil2 * 1.4) * (0.1 + 1.3 * near) + rays * near * 0.32
    emission = color * glow[:, None]
    emission += np.array([1.0, 0.92, 0.9], dtype=np.float32) * (
        np.exp(-r / 0.022) * 40 + np.exp(-r / 0.075) * 3.2
    )[:, None]
    emission += hexrgb(c["ramp"][1]) * (0.012 + 0.08 * near * near + 0.05 * soft**3)[:, None]
    return emission * c.get("gain", 1.0), 0.1 + smooth(0.56, 0.74, f.at(f.soft, q, 1.3, 0.7)) * 3.2


def veils(f, p, c):
    q = f.warped(p, 0.9, 0.5)
    sheets = np.zeros(len(p), dtype=np.float32)
    for scale, shift, width, weight in ((0.5, 0.0, 0.03, 1.0), (0.72, 0.33, 0.022, 0.9), (0.95, 0.71, 0.016, 0.7)):
        level = f.at(f.soft, q, scale, shift)
        sheets += weight * np.exp(-(((level - 0.5) / width) ** 2))
    texture = 0.45 + 1.1 * f.at(f.big, q, 1.1)
    temp = clamp(f.at(f.soft, p, 0.55, 0.55) * 1.15 - 0.08)
    emission = ramp(temp, c["ramp"]) * (sheets * texture * 0.85)[:, None]
    emission += hexrgb(c["ramp"][0]) * (0.05 * (0.2 + f.at(f.soft, q, 0.7, 0.8)))[:, None]
    return emission * c.get("gain", 1.0), 0.08 + sheets * 0.35


def halo(f, p, c):
    n = disc_normal(c)
    n /= np.linalg.norm(n)
    q = f.warped(p, 0.1, 0.8)
    h = q @ n
    rho = np.sqrt(np.maximum((q * q).sum(axis=1) - h * h, 1e-8))
    soft = f.at(f.soft, q, 1.2)
    bands = (0.5 + 0.5 * np.cos(rho * 64 + soft * 7)) ** 2 + 0.6 * (0.5 + 0.5 * np.cos(rho * 150 + soft * 11)) ** 4
    ring = (smooth(0.36, 0.44, rho) * (1 - smooth(0.72, 0.8, rho))) * np.exp(-((h / 0.022) ** 2))
    temp = clamp(1.06 - rho * 1.05 + 0.2 * (soft - 0.5))
    emission = ramp(temp, c["ramp"]) * (ring * (0.12 + bands * 1.55) * 3.2)[:, None]
    r = np.sqrt((p * p).sum(axis=1)) + 1e-4
    emission += np.array([1.0, 0.9, 0.74], dtype=np.float32) * (
        np.exp(-r / 0.03) * 22 + np.exp(-r / 0.1) * 1.0
    )[:, None]
    jet = np.exp(-((rho / (0.012 + 0.07 * np.abs(h))) ** 2)) * np.exp(-np.abs(h) / 0.6)
    emission += hexrgb(c["ramp"][2]) * (jet * 1.2)[:, None]
    emission += hexrgb(c["ramp"][0]) * (0.03 + 0.1 * f.at(f.soft, q, 0.8, 0.4) ** 2)[:, None]
    return emission * c.get("gain", 1.0), 0.06 + ring * 7


def sovereign(f, p, c):
    """Black glass and gold: an eye swallowing light, foil arms, flares beyond it."""
    n = disc_normal(c)
    n /= np.linalg.norm(n)
    e1 = np.cross(n, (0.0, 1.0, 0.0)).astype(np.float32)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)
    q = f.warped(p, 0.09, 0.8)
    h, u, v = q @ n, q @ e1, q @ e2
    rho = np.sqrt(u * u + v * v) + 1e-4
    phi = np.arctan2(v, u)
    soft = f.at(f.soft, q, 1.0)
    grain = f.at(f.big, q, 2.0)
    spiral = phi - c["twist"] * np.log(rho + 0.03)
    wobble = (soft - 0.5) * 2.3
    arms = (0.5 + 0.5 * np.cos(c["arms"] * spiral + wobble)) ** 2.6
    foil = np.zeros_like(arms)
    for count, weight, power in ((9, 1.0, 14), (17, 0.85, 22), (31, 0.7, 30), (53, 0.5, 34)):
        foil += weight * (0.5 + 0.5 * np.cos(count * spiral + wobble * 1.8 + grain * 2.4)) ** power
    plate = np.exp(-((h / (0.022 + 0.085 * rho)) ** 2))
    eye = c["hole"]
    ph = p @ n
    pr = np.sqrt(np.maximum((p * p).sum(axis=1) - ph * ph, 1e-8))
    reach = smooth(eye * 1.0, eye * 1.5, pr) * (1 - smooth(0.82, 1.04, rho))
    density = plate * reach * (0.08 + arms)
    temp = clamp(0.98 - rho * 0.95 + 0.34 * (grain - 0.5))
    glow = density * (0.04 + foil * 3.4 + grain**4 * 2.6) * 1.6
    emission = ramp(temp, c["ramp"]) * glow[:, None]
    # Light pouring toward the eye, in the deep orange of a dying fire.
    inflow = np.exp(-(((pr - eye * 1.9) / 0.12) ** 2)) * np.exp(-((ph / 0.05) ** 2))
    emission += hexrgb("#ff5a10") * (inflow * (0.1 + foil * 1.5))[:, None]
    # Thin gold smoke, mostly out past the arms, so black stays black.
    sheet = np.exp(-(((f.at(f.soft, f.warped(p, 0.8, 0.5), 0.62, 0.21) - 0.5) / 0.015) ** 2))
    r = np.sqrt((p * p).sum(axis=1)) + 1e-4
    emission += ramp(clamp(0.72 - r * 0.4), c["ramp"]) * (sheet * (0.2 + 0.5 * grain) * smooth(0.3, 0.75, r))[:, None]
    lanes = plate * (1 - arms) * reach
    return emission * c.get("gain", 1.0), 0.05 + lanes * 11


KINDS = {
    "nebula": nebula,
    "vortex": vortex,
    "burst": burst,
    "veils": veils,
    "halo": halo,
    "sovereign": sovereign,
}


# ---------------------------------------------------------------------------
# The trace.


def camera(size):
    axis = (np.arange(size, dtype=np.float32) + 0.5) / size * 2 - 1
    x, y = np.meshgrid(axis, axis)
    return x, y, np.sqrt(x * x + y * y)


def rays(x, y, r):
    """Where each pixel's ray enters the ball, and which way it bends."""
    inside = r < 0.999
    px, py = x[inside], y[inside]
    pz = -np.sqrt(np.maximum(1 - px * px - py * py, 1e-6))
    normal = np.stack([px, py, pz], axis=-1)
    incoming = np.array([0, 0, 1], dtype=np.float32)
    cos_i = -(normal @ incoming)
    eta = 1 / IOR
    k = 1 - eta * eta * (1 - cos_i * cos_i)
    direction = eta * incoming + (eta * cos_i - np.sqrt(np.maximum(k, 0)))[:, None] * normal
    direction /= np.linalg.norm(direction, axis=1, keepdims=True)
    chord = -2 * (normal * direction).sum(axis=1)
    return inside, normal.astype(np.float32), direction.astype(np.float32), chord.astype(np.float32)


def rotation(angle, axis):
    """Rodrigues: the turn about `axis` that a loop of the orb steps through."""
    k = np.array(axis, dtype=np.float32)
    k /= np.linalg.norm(k)
    cross = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]], dtype=np.float32)
    return np.eye(3, dtype=np.float32) + math.sin(angle) * cross + (1 - math.cos(angle)) * cross @ cross


DISC_NORMALS = {"vortex": (0.1, -0.34, 0.93), "halo": (0.28, -0.8, 0.53)}


def disc_normal(orb):
    return np.array(orb.get("normal", DISC_NORMALS.get(orb["kind"])), dtype=np.float32)


def spin_axis(orb):
    """Discs turn in their own plane; clouds roll about a leaning axis."""
    if orb["kind"] in ("vortex", "halo", "sovereign"):
        return disc_normal(orb)
    return orb.get("axis", (0.32, 0.9, 0.28))


def march(orb, fields, size, steps, angle=0.0):
    x, y, r = camera(size)
    inside, start, direction, chord = rays(x, y, r)
    turn = rotation(angle, spin_axis(orb))
    shader = KINDS[orb["kind"]]
    count = len(start)
    jitter = np.random.default_rng(7).random(count).astype(np.float32)
    light = np.zeros((count, 3), dtype=np.float32)
    through = np.ones(count, dtype=np.float32)
    dt = chord / steps
    for step in range(steps):
        p = (start + direction * (chord * ((step + jitter) / steps))[:, None]) @ turn.T
        emission, absorb = shader(fields, p, orb)
        fade = smooth(1.0, 0.86, np.sqrt((p * p).sum(axis=1)))
        light += (through * dt * fade)[:, None] * emission * 1.7
        through *= np.exp(-absorb * dt * fade * orb.get("density", 1.4))
    image = np.zeros((size, size, 3), dtype=np.float32)
    image[inside] = light
    return image


def filmic(linear, exposure, saturation=1.22):
    """ACES fit: keeps blacks black, then gives back the color highlights lose."""
    v = linear * exposure
    mapped = clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14))
    grey = mapped @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    return clamp(grey[..., None] + (mapped - grey[..., None]) * saturation) ** (1 / 2.2)


def core_glow(size, orb):
    """Light too fine for the trace to land on, added where the eye sees it."""
    x, y, r = camera(size)
    cx, cy = orb["core"]
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) + 1e-4
    a = np.arctan2(y - cy, x - cx)
    spikes = (0.5 + 0.5 * np.cos(a * 6 + 0.5)) ** 24 + 0.6 * (0.5 + 0.5 * np.cos(a * 10 + 1.9)) ** 40
    level = np.exp(-d / 0.022) * 26 + np.exp(-d / 0.075) * 2.4 + spikes * np.exp(-d / 0.17) * 1.5
    tint = hexrgb(orb.get("core_tint", "#fff2e6"))
    return level[..., None] * tint * orb.get("core_gain", 1.0)


def eye_distance(size, orb):
    x, y, _ = camera(size)
    return np.sqrt(x * x + (y / orb.get("eye_squash", 0.94)) ** 2) + 1e-4


def eye_glow(size, orb, angle=0.0):
    """The rim of the black eye: a burning ring, its bloom, and rays leaving it."""
    x, y, _ = camera(size)
    radius = orb["eye"]
    d = eye_distance(size, orb)
    a = np.arctan2(y, x) - angle
    # Hotter on one side, the way a spinning disc is brighter coming toward you.
    beam = 0.55 + 0.45 * np.cos(a - 2.4)
    ring = np.exp(-(((d - radius) / 0.0085) ** 2)) * 15 * (0.55 + 0.75 * beam)
    bloom = np.exp(-(((d - radius) / 0.03) ** 2)) * 1.55 * beam
    wide = np.exp(-np.maximum(d - radius, 0) / 0.11) * (d > radius) * 0.5 * beam
    rays = np.zeros_like(d)
    for count, spin, power, reach in ((13, 0.4, 30, 0.3), (29, 1.7, 46, 0.17), (7, 2.9, 22, 0.42), (41, 0.9, 60, 0.11)):
        rays += (0.5 + 0.5 * np.cos(a * count + spin)) ** power * np.exp(-np.maximum(d - radius, 0) / reach)
    rays *= (d > radius) * 0.72
    gold = hexrgb("#ffc34a")
    hot = hexrgb("#fff3d0")
    return ring[..., None] * hot + (bloom + wide + rays)[..., None] * gold


def star_points(rng, orb, fields, amount):
    """Stars gather where the gas is bright, with a thin scatter everywhere."""
    candidates = rng.normal(size=(amount * 5, 3)).astype(np.float32)
    candidates /= np.linalg.norm(candidates, axis=1, keepdims=True)
    candidates *= (rng.random(amount * 5).astype(np.float32) ** (1 / 3))[:, None] * 0.97
    emission, _ = KINDS[orb["kind"]](fields, candidates, orb)
    weight = emission.max(axis=1)
    weight = weight / (np.percentile(weight, 97) + 1e-5)
    keep = rng.random(len(candidates)) < clamp(weight) * 0.75 + 0.1
    points = candidates[keep][:amount]
    magnitude = (rng.pareto(1.25, len(points)) + 1).astype(np.float32)
    tints = np.stack([hexrgb(t) * 0.75 + 0.25 for t in orb["stars"]])
    return points, magnitude, tints[rng.integers(0, len(tints), len(points))]


def stars(points, magnitude, tint, size, sparkles, turn=None):
    p = points if turn is None else points @ turn
    r = np.sqrt((p[:, :2] ** 2).sum(axis=1)) + 1e-5
    seen = np.sin(clamp(r, 0, 1) * math.pi / 2) / r  # The ball magnifies its middle.
    sx = ((p[:, 0] * seen + 1) / 2 * size).astype(np.int32)
    sy = ((p[:, 1] * seen + 1) / 2 * size).astype(np.int32)
    on = (sx >= 0) & (sx < size) & (sy >= 0) & (sy < size)
    nearness = 0.35 + 0.65 * (-p[:, 2] * 0.5 + 0.5)
    level = np.minimum(magnitude, 9) ** 1.5 * nearness * 0.1
    scale = size / 768
    pin = np.zeros((size, size, 3), dtype=np.float32)
    np.add.at(pin, (sy[on], sx[on]), (tint * level[:, None])[on])
    light = gaussian_filter(pin, sigma=(0.7 * scale + 0.2,) * 2 + (0,)) * 4
    # A handful of real sparkles; every star doing this reads as glitter.
    top = np.argsort(magnitude * nearness * on)[-sparkles:]
    big = np.zeros_like(pin)
    np.add.at(big, (sy[top], sx[top]), tint[top] * (8 + np.minimum(magnitude[top], 30)[:, None] * 0.6))
    light += gaussian_filter(big, sigma=(1.3 * scale + 0.25,) * 2 + (0,)) * 2.4
    light += gaussian_filter(big, sigma=(5 * scale,) * 2 + (0,)) * 2.6
    spike = gaussian_filter(big, sigma=(0.5 * scale + 0.2, 5 * scale, 0))
    spike += gaussian_filter(big, sigma=(5 * scale, 0.5 * scale + 0.2, 0))
    return light + spike * 0.9


# ---------------------------------------------------------------------------
# The glass. Everything here stays still while the inside turns.


def glass(size, rim, glow):
    x, y, r = camera(size)
    rc = clamp(r, 0, 0.9995)
    nz = np.sqrt(1 - rc * rc)
    # The camera looks along +z; a sphere's surface faces back at it.
    normal = np.stack([x, y, -nz], axis=-1)
    reflect = np.array([0, 0, 1], dtype=np.float32) + 2 * nz[..., None] * normal
    fresnel = 0.04 + 0.96 * (1 - nz) ** 5

    # What the ball reflects: a bright window, and a sky that fades to the floor.
    light = np.array([-0.5, -0.62, -0.6], dtype=np.float32)
    light /= np.linalg.norm(light)
    side = np.cross(light, (0.0, 1.0, 0.0)).astype(np.float32)
    side /= np.linalg.norm(side)
    up = np.cross(side, light)
    toward = reflect @ light
    u, v = (reflect @ side) / np.maximum(toward, 0.05), (reflect @ up) / np.maximum(toward, 0.05)
    pane = np.exp(-((u / 0.3) ** 4 + ((v + 0.8 * u * u) / 0.1) ** 4)) * (toward > 0)
    sky = smooth(0.2, -0.95, reflect[..., 1])
    tint = hexrgb(rim) ** 0.75
    environment = pane[..., None] * np.array([4.6, 5.0, 5.8], dtype=np.float32)
    environment = environment + sky[..., None] * tint * 0.55

    rgb = np.zeros((size, size, 3), dtype=np.float32)
    alpha = np.zeros((size, size), dtype=np.float32)

    def over(color, mask):
        nonlocal rgb, alpha
        mask = clamp(mask)
        rgb = rgb * (1 - mask[..., None]) + np.asarray(color, dtype=np.float32) * mask[..., None]
        alpha = alpha * (1 - mask) + mask

    # Light has further to go through the glass near the edge, and it dims.
    lower = smooth(-0.8, 0.9, x * 0.42 + y * 0.9)
    over((0.0, 0.0, 0.004), (1 - np.exp(-2.1 * (1 / np.maximum(nz, 0.12) - 1) ** 1.25)) * (0.5 + 0.5 * lower))
    # What gets through gathers opposite the window.
    side_on = smooth(0.35, 1.0, (x * 0.42 + y * 0.9) / np.maximum(r, 0.05))
    caustic = np.exp(-(((r - 0.945) / 0.03) ** 2)) * side_on**1.4
    over(hexrgb(glow) ** 0.5, caustic * 0.4)
    reflection = environment * fresnel[..., None]
    strength = clamp(reflection.max(axis=-1))
    over(reflection / np.maximum(reflection.max(axis=-1, keepdims=True), 1e-4), strength)
    # The sun: one small hard point with a little bloom.
    d = (x + 0.33) ** 2 + (y + 0.44) ** 2
    over((1, 1, 1), np.exp(-d / 0.0005) * 0.97 + np.exp(-d / 0.0045) * 0.16)
    return rgb, alpha


def corona(size, rng):
    """Gold fire around the sphere, drawn at 1.24 times its width, to turn behind it."""
    x, y, r = camera(size)
    r = r * 1.24  # In sphere radii, so the ball's edge sits at 1.
    a = np.arctan2(y, x)
    flame = np.zeros_like(r)
    for count, reach, power in ((5, 0.16, 3), (11, 0.11, 5), (23, 0.07, 9), (47, 0.05, 14)):
        spin = rng.random() * 6.28
        flame += (0.5 + 0.5 * np.cos(a * count + spin)) ** power * np.exp(-np.maximum(r - 1, 0) / reach)
    glow = np.exp(-np.maximum(r - 1, 0) / 0.05) * 0.8 + flame * 0.55
    glow = glow * smooth(1.24, 1.1, r) * smooth(0.9, 0.98, r)
    color = ramp(clamp(glow * 0.95), ["#8a3a04", "#d9730a", "#ffa914", "#ffcf4a"]) ** (1 / 2.2)
    return color, clamp(glow * 0.92) ** 1.05


def disc(size, radius=0.994):
    _, _, r = camera(size)
    return clamp((radius - r) * size / 2 + 0.5)


def save(rgb, alpha, path, size, quality):
    pixels = np.concatenate([clamp(rgb) * alpha[..., None], alpha[..., None]], axis=-1)
    channels = [
        np.asarray(Image.fromarray(np.ascontiguousarray(pixels[..., c])).resize((size, size), Image.LANCZOS))
        for c in range(4)
    ]
    out = np.stack(channels, axis=-1)
    a = clamp(out[..., 3:4])
    straight = np.where(a > 1e-4, clamp(out[..., :3]) / np.maximum(a, 1e-4), 0)
    data = (clamp(np.concatenate([straight, a], axis=-1)) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(data).save(path, "WEBP", quality=quality, method=6, alpha_quality=92)


def exposure_gain(orb, fields):
    """Where the gas lands is chance, so each cloud is exposed for itself."""
    if orb["kind"] not in ("nebula", "veils"):
        return 1.0
    level = march(orb, fields, 256, 40).max(axis=-1)
    return min(7.0, orb.get("target", 0.62) / np.percentile(level[level > 0], 93))


def gas(orb, fields, size, steps, gain, angle=0.0):
    light = march(orb, fields, size, steps, angle) * gain
    if "eye" in orb:
        light = light * smooth(orb["eye"] * 0.94, orb["eye"], eye_distance(size, orb))[..., None]
    if "core" in orb:
        light = light + core_glow(size, orb)
    if "eye" in orb:
        light = light + eye_glow(size, orb, angle)
    return filmic(light, orb.get("exposure", 1.0))


def dust_field(orb, stardust, size, angle=0.0):
    points, magnitude, tint = stardust
    light = stars(points, magnitude, tint, size, orb.get("sparkles", 9), rotation(angle, spin_axis(orb)))
    if "eye" in orb:
        light = light * smooth(orb["eye"] * 0.98, orb["eye"] * 1.04, eye_distance(size, orb))[..., None]
    return light


def render(orb, out, size, work, steps):
    rng = np.random.default_rng(orb["seed"])
    fields = Fields(rng)
    gain = exposure_gain(orb, fields)
    edge = disc(work)
    save(gas(orb, fields, work, steps, gain), edge, out / f"{orb['name']}-deep.webp", size, 86)

    stardust = star_points(rng, orb, fields, orb.get("star_count", 6500))
    dust = dust_field(orb, stardust, work)
    strength = clamp(dust.max(axis=-1))
    colored = dust / np.maximum(dust.max(axis=-1, keepdims=True), 1e-4)
    save(colored ** (1 / 2.2), strength**0.8 * edge, out / f"{orb['name']}-dust.webp", size, 84)

    rgb, alpha = glass(work, orb.get("rim", "#9fb6d8"), orb.get("glow", orb["ramp"][-2]))
    save(rgb ** (1 / 2.2), alpha * edge, out / f"{orb['name']}-glass.webp", size, 86)

    if "eye" in orb:
        rgb, alpha = corona(work, rng)
        save(rgb, alpha, out / f"{orb['name']}-corona.webp", size, 84)


def render_loop(orb, out, size, steps, frames, seconds, only_frames=None):
    """One full turn in 3D as a seamless clip, for the sizes where it can be seen."""
    rng = np.random.default_rng(orb["seed"])
    fields = Fields(rng)
    gain = exposure_gain(orb, fields)
    stardust = star_points(rng, orb, fields, orb.get("star_count", 6500))
    folder = out / f"{orb['name']}-frames"
    folder.mkdir(parents=True, exist_ok=True)
    fine = size * 2  # Stars land on a finer grid so they glide, not hop.
    for index in range(frames) if only_frames is None else only_frames:
        target = folder / f"{index:04d}.png"
        if target.exists():
            continue
        angle = 2 * math.pi * index / frames
        image = gas(orb, fields, size, steps, gain, angle)
        dust = dust_field(orb, stardust, fine, angle)
        strength = clamp(dust.max(axis=-1))
        colored = (dust / np.maximum(dust.max(axis=-1, keepdims=True), 1e-4)) ** (1 / 2.2)
        over = (strength**0.8)[..., None]
        layer = colored * over
        small = layer.reshape(size, 2, size, 2, 3).mean(axis=(1, 3))
        cover = over.reshape(size, 2, size, 2, 1).mean(axis=(1, 3))
        image = image * (1 - cover) + small
        pixels = (clamp(image) * disc(size)[..., None] * 255 + 0.5).astype(np.uint8)
        temporary = target.with_suffix(f".{os.getpid()}.png")
        Image.fromarray(pixels).save(temporary)
        temporary.rename(target)
    return folder


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=pathlib.Path)
    parser.add_argument("--size", type=int, default=384)
    parser.add_argument("--work", type=int, default=768)
    parser.add_argument("--steps", type=int, default=56)
    parser.add_argument("--only", default="")
    parser.add_argument("--loop", type=int, default=0, help="frames in a full turn; 0 for stills")
    parser.add_argument("--slice", default="", help="i/n: this worker's share of each loop")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    wanted = set(filter(None, args.only.split(",")))
    for orb in ORBS:
        if wanted and orb["name"] not in wanted:
            continue
        if args.loop:
            share = None
            if args.slice:
                i, n = (int(v) for v in args.slice.split("/"))
                share = range(i, args.loop, n)
            render_loop(orb, args.out, args.size, args.steps, args.loop, 0, share)
        else:
            render(orb, args.out, args.size, args.work, args.steps)
        print(orb["name"], flush=True)


if __name__ == "__main__":
    main()
