# Particle Simulator

A small, dependency-free 2D particle simulator written in C99. It runs a
physics loop with gravity and collisions and renders the result live in your
terminal using ANSI escape codes — no graphics libraries required.

```
+----------------------------------------+
|                                        |
|              . .                       |
|            . :=+ .                      |
|          .:=*#%*=:.                     |
|       ..:=+*#%%#*+=:..                  |
|.::-=+*#%@@@@@@@@%#*+=-::.               |
+----------------------------------------+
particles=200  gravity=9.8  restitution=0.85  frame=142
```

## Physics

- **Verlet integration** — positions are advanced from position history, so
  velocity is implicit and the integrator stays stable under stacking.
- **Gravity** — a constant downward acceleration baked into each step.
- **Particle collisions** — pairwise overlap resolution pushes overlapping
  particles apart symmetrically along their center line.
- **Wall collisions** — particles bounce off the box walls, retaining a
  configurable fraction of their velocity (restitution).

Four physics substeps run per rendered frame, decoupling simulation accuracy
from the frame rate.

## Build

Requires a C compiler and `make`. On any Linux/macOS system:

```sh
make
```

Or without make:

```sh
cc -std=c99 -O2 -o particle_sim particle_sim.c -lm
```

## Run

```sh
./particle_sim              # defaults: 200 particles, 70x30 grid
make run                    # same thing
```

Press **Ctrl-C** to quit (the cursor is restored on exit).

## Options

| Flag | Long form | Default | Description |
|------|-----------|---------|-------------|
| `-n` | `--particles` | 200 | number of particles |
| `-W` | `--width` | 70 | grid width in characters |
| `-H` | `--height` | 30 | grid height in characters |
| `-g` | `--gravity` | 9.8 | gravitational acceleration |
| `-e` | `--restitution` | 0.85 | wall bounciness (0..1) |
| `-r` | `--radius` | 0.6 | particle radius |
| `-f` | `--fps` | 30 | target frames per second |
|      | `--frames` | 0 | stop after N frames (0 = run forever) |
| `-s` | `--seed` | time | RNG seed (fix it for reproducible runs) |
| `-h` | `--help` | | show help and exit |

### Examples

```sh
# A dense, bouncy pit
./particle_sim -n 400 -e 0.95

# Low gravity, slow motion
./particle_sim -g 2.0 -f 20

# A reproducible 100-frame run (deterministic for a fixed seed)
./particle_sim -s 42 --frames 100
```

## How rendering works

The continuous world is divided into a grid of character cells. Each frame,
particles are bucketed into cells and each cell is drawn with a character from
a density ramp (` .:-=+*#%@`) — the more particles in a cell, the brighter the
glyph. The whole frame is composed into one buffer and written in a single call
to avoid tearing.
