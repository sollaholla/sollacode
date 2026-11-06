"""Every orb: what fills it, its colors, and the seed that fixes its shape.

The order is the agents' order: an agent's stored color index picks its orb, so
never reorder this list. `sovereign` is the orchestrator's and no agent's.
"""

W = ["#ffffff"]

ORBS = [
    dict(name="orion", kind="nebula", seed=11, rim="#7f9ad8", accent="#ff2f86", stars=W + ["#ffe6b0", "#bcd4ff"],
         ramp=["#050a3c", "#1236c8", "#7a2fe0", "#ff2f86", "#ff8a4a", "#ffe8c8"]),
    dict(name="abyss", kind="vortex", seed=22, hole=0.13, rim="#5aa898", accent="#23c9a6", stars=W + ["#ffe29a", "#a8fff0"],
         ramp=["#031a1c", "#0b6a66", "#23c9a6", "#b8e07a", "#f6d76a", "#fff4c8"]),
    dict(name="ember", kind="burst", seed=33, rim="#ff7a6a", glow="#ff4a5a", core=(0.0, 0.0), focus=(0.0, 0.0, 0.0), accent="#e63bd0",
         stars=W + ["#ffd27a", "#ffb0d0"], ramp=["#060b48", "#1c2fd8", "#6a3cf0", "#e63bd0", "#ff5a6a", "#ffd7a0"]),
    dict(name="aurora", kind="veils", seed=44, rim="#62c8b4", accent="#32f0b0", stars=W + ["#baffe8", "#c6c0ff"],
         ramp=["#031a48", "#0b57d0", "#17c6e0", "#32f0b0", "#7dff90", "#d8ffb0"]),
    dict(name="saturn", kind="halo", seed=55, rim="#ab8dd8", accent="#ff8a3a", stars=W + ["#ffd9a0", "#d6c0ff"],
         ramp=["#170a2c", "#5a2fa8", "#c2467a", "#ff8a3a", "#ffc860", "#fff0c8"]),
    dict(name="rosette", kind="nebula", seed=66, focus=(-0.16, 0.1, 0.0), rim="#d88fb0", accent="#ff5a8a", stars=W + ["#ffd0d8", "#ffe8b0"],
         ramp=["#2a0520", "#8a1050", "#e0266e", "#ff6a6a", "#ffb060", "#fff0d0"]),
    dict(name="maelstrom", kind="vortex", seed=77, hole=0.1, arms=3, twist=2.6, rim="#a48af0", accent="#a74cff", stars=W + ["#e0c0ff", "#ffc0e8"],
         ramp=["#0c0530", "#3a1aa8", "#7a3cf0", "#d04ae0", "#ff80c0", "#ffe6f4"]),
    dict(name="nova", kind="burst", seed=88, rim="#60d0d8", glow="#30e0d0", core=(0.0, 0.0), focus=(0.0, 0.0, 0.0), accent="#18d0c0", core_tint="#eefff6",
         stars=W + ["#b0fff0", "#ffe8a0"], ramp=["#02202a", "#066a78", "#10b0a8", "#40e0a0", "#d0e870", "#fff4c0"]),
    dict(name="siren", kind="veils", seed=99, rim="#e090b0", accent="#ff5aa0", stars=W + ["#ffd0e8", "#ffe0b0"],
         ramp=["#1c0638", "#6a12a0", "#d0209a", "#ff5a7a", "#ffa04a", "#ffd890"]),
    dict(name="solstice", kind="vortex", seed=110, arms=2, twist=2.2, tight=1.3, rim="#e0a060", accent="#ff7a2a", stars=W + ["#ffd090", "#ffb080"],
         ramp=["#200604", "#7a1a0a", "#e0401a", "#ff8a2a", "#ffc860", "#fff2c8"]),
    dict(name="glacier", kind="halo", seed=121, normal=(-0.3, -0.7, 0.64), rim="#a0d0f0", accent="#58b8ff", stars=W + ["#c0e4ff", "#e0f0ff"],
         ramp=["#04102c", "#0e3a90", "#1e7ae0", "#58c0ff", "#b0ecff", "#f0fcff"]),
    dict(name="verdant", kind="nebula", seed=132, focus=(0.1, 0.14, 0.0), rim="#88c890", accent="#5ae05a", stars=W + ["#d0ffb0", "#fff0a0"],
         ramp=["#02140e", "#0a5a3a", "#14a860", "#60e050", "#d0e860", "#fff8c8"]),
    dict(name="tempest", kind="veils", seed=143, rim="#90a0f0", accent="#6a7aff", stars=W + ["#c0c8ff", "#a0f0ff"],
         ramp=["#060a38", "#1a24a8", "#4a4cf0", "#8a5cff", "#40c8f0", "#c0f4ff"]),
    dict(name="pulsar", kind="burst", seed=154, rim="#e8b060", glow="#ffa030", core=(0.0, 0.0), focus=(0.0, 0.0, 0.0), accent="#ffb020", core_tint="#fff0d0",
         stars=W + ["#ffe0a0", "#ffc080"], ramp=["#1a0730", "#5a1a88", "#c02a70", "#ff6a30", "#ffb030", "#fff0b0"]),
    dict(name="cobalt", kind="nebula", seed=165, focus=(-0.05, -0.15, 0.0), rim="#80a8e0", accent="#3a8cff", stars=W + ["#c0dcff", "#ffffff"],
         ramp=["#020a2a", "#0a2a90", "#1460e0", "#3ca0ff", "#a0dcff", "#f4fcff"]),
    dict(name="crimson", kind="vortex", seed=176, hole=0.12, arms=4, twist=2.3, tight=2.0, rim="#d07070", accent="#ff3040", stars=W + ["#ffc0a0", "#ffd0d0"],
         ramp=["#1c0206", "#6a0a14", "#d01a2a", "#ff4a3a", "#ffa060", "#ffe8c8"]),
    dict(name="sovereign", kind="sovereign", seed=777, hole=0.13, eye=0.235, arms=3, twist=2.9, normal=(0.06, -0.2, 0.98),
         rim="#ffcf70", glow="#ffb92e", accent="#ffc83a", sparkles=22, star_count=12000, exposure=1.0,
         stars=W + ["#ffe9a0", "#ffc860", "#ffb030"],
         ramp=["#160902", "#6a3506", "#c9780c", "#ffb81e", "#ffdf70", "#fff6d0"]),
]
