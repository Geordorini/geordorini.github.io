/*
 * particle_sim.c — a small 2D particle simulator that renders to the terminal.
 *
 * Physics:
 *   - Verlet integration for stable motion
 *   - constant gravity
 *   - elastic particle/particle collisions with positional correction
 *   - wall collisions with configurable restitution
 *
 * Rendering:
 *   - ANSI escape codes, no external libraries
 *   - particles are bucketed into a character grid; denser cells draw brighter
 *
 * Build:  make          (or: cc -O2 -o particle_sim particle_sim.c -lm)
 * Run:    ./particle_sim --help
 *
 * Everything is standard C99 + POSIX (nanosleep, signal). No dependencies.
 */

#define _POSIX_C_SOURCE 199309L  /* expose nanosleep / struct timespec */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <signal.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

typedef struct {
    int    n_particles;   /* number of particles                     */
    int    grid_w;        /* render grid width  (characters)         */
    int    grid_h;        /* render grid height (characters)         */
    double gravity;       /* downward acceleration (world units/s^2) */
    double restitution;   /* wall bounce energy retained (0..1)      */
    double radius;        /* particle radius (world units)           */
    double dt;            /* physics timestep (seconds)              */
    int    fps;           /* target frames per second                */
    long   max_frames;    /* stop after this many frames (0 = forever)*/
    unsigned seed;        /* RNG seed                                 */
} Config;

/* The simulation lives in a [0, world_w] x [0, world_h] box. We keep
 * the world square-ish relative to the character grid, accounting for
 * terminal cells being about twice as tall as they are wide. */
static double g_world_w;
static double g_world_h;

/* ------------------------------------------------------------------ */
/* Particle state (Verlet: we store current + previous position)       */
/* ------------------------------------------------------------------ */

typedef struct {
    double x,  y;    /* current position   */
    double px, py;   /* previous position  */
} Particle;

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

static double frand(double lo, double hi) {
    return lo + (hi - lo) * ((double)rand() / (double)RAND_MAX);
}

static double clampd(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

/* Ctrl-C handling so we can restore the cursor on exit. */
static volatile sig_atomic_t g_running = 1;
static void on_sigint(int sig) { (void)sig; g_running = 0; }

/* ------------------------------------------------------------------ */
/* Physics                                                            */
/* ------------------------------------------------------------------ */

/* Advance every particle with Verlet integration.
 * Velocity is implicit: v = (x - px) / dt, so we bake gravity into the
 * position update and recover velocity from the position history. */
static void integrate(Particle *p, int n, const Config *cfg) {
    const double dt2 = cfg->dt * cfg->dt;
    for (int i = 0; i < n; ++i) {
        double vx = p[i].x - p[i].px;
        double vy = p[i].y - p[i].py;

        p[i].px = p[i].x;
        p[i].py = p[i].y;

        p[i].x += vx;                          /* inertia            */
        p[i].y += vy + cfg->gravity * dt2;     /* inertia + gravity  */
    }
}

/* Bounce particles off the four walls, losing energy per restitution. */
static void solve_walls(Particle *p, int n, const Config *cfg) {
    const double r = cfg->radius;
    const double e = cfg->restitution;
    for (int i = 0; i < n; ++i) {
        double vx = p[i].x - p[i].px;
        double vy = p[i].y - p[i].py;

        if (p[i].x < r) {
            p[i].x  = r;
            p[i].px = p[i].x + vx * e;   /* flip & damp horizontal velocity */
        } else if (p[i].x > g_world_w - r) {
            p[i].x  = g_world_w - r;
            p[i].px = p[i].x + vx * e;
        }

        if (p[i].y < r) {
            p[i].y  = r;
            p[i].py = p[i].y + vy * e;
        } else if (p[i].y > g_world_h - r) {
            p[i].y  = g_world_h - r;
            p[i].py = p[i].y + vy * e;   /* flip & damp vertical velocity */
        }
    }
}

/* Resolve pairwise overlaps. O(n^2) is plenty for a terminal-sized sim;
 * particles are pushed apart symmetrically along their center line. */
static void solve_collisions(Particle *p, int n, const Config *cfg) {
    const double min_dist = 2.0 * cfg->radius;
    for (int i = 0; i < n; ++i) {
        for (int j = i + 1; j < n; ++j) {
            double dx = p[j].x - p[i].x;
            double dy = p[j].y - p[i].y;
            double d2 = dx * dx + dy * dy;
            if (d2 >= min_dist * min_dist || d2 == 0.0) continue;

            double d = sqrt(d2);
            double overlap = 0.5 * (min_dist - d);
            double nx = dx / d;
            double ny = dy / d;

            p[i].x -= nx * overlap;
            p[i].y -= ny * overlap;
            p[j].x += nx * overlap;
            p[j].y += ny * overlap;
        }
    }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

/* Density ramp from empty to packed. */
static const char *DENSITY = " .:-=+*#%@";

static void render(const Particle *p, int n, const Config *cfg, char *buf, int *counts) {
    const int w = cfg->grid_w;
    const int h = cfg->grid_h;
    const int cells = w * h;

    memset(counts, 0, (size_t)cells * sizeof(int));

    /* Bucket particles into character cells. */
    for (int i = 0; i < n; ++i) {
        int cx = (int)(p[i].x / g_world_w * w);
        int cy = (int)(p[i].y / g_world_h * h);
        cx = (int)clampd(cx, 0, w - 1);
        cy = (int)clampd(cy, 0, h - 1);
        counts[cy * w + cx]++;
    }

    /* Compose one string with a border, then blit it in a single write. */
    const int ramp_max = (int)strlen(DENSITY) - 1;
    char *out = buf;

    *out++ = '+';
    for (int x = 0; x < w; ++x) *out++ = '-';
    *out++ = '+';
    *out++ = '\n';

    for (int y = 0; y < h; ++y) {
        *out++ = '|';
        for (int x = 0; x < w; ++x) {
            int c = counts[y * w + x];
            if (c > ramp_max) c = ramp_max;
            *out++ = DENSITY[c];
        }
        *out++ = '|';
        *out++ = '\n';
    }

    *out++ = '+';
    for (int x = 0; x < w; ++x) *out++ = '-';
    *out++ = '+';
    *out++ = '\n';
    *out = '\0';
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

static void usage(const char *prog) {
    printf(
        "Usage: %s [options]\n\n"
        "A dependency-free 2D particle simulator rendered in the terminal.\n\n"
        "Options:\n"
        "  -n, --particles N    number of particles       (default 200)\n"
        "  -W, --width W        grid width in chars        (default 70)\n"
        "  -H, --height H       grid height in chars       (default 30)\n"
        "  -g, --gravity G      gravitational accel        (default 9.8)\n"
        "  -e, --restitution E  wall bounciness 0..1       (default 0.85)\n"
        "  -r, --radius R       particle radius            (default 0.6)\n"
        "  -f, --fps F          target frames per second   (default 30)\n"
        "      --frames M       stop after M frames (0=inf)(default 0)\n"
        "  -s, --seed S         RNG seed                   (default time)\n"
        "  -h, --help           show this help and exit\n\n"
        "Press Ctrl-C to quit. Physics uses Verlet integration with\n"
        "elastic particle collisions and damped wall bounces.\n",
        prog);
}

/* Parse an integer/double argument or die with a clear message. */
static long need_long(const char *flag, const char *val) {
    char *end;
    long v = strtol(val, &end, 10);
    if (*end != '\0') { fprintf(stderr, "error: %s expects an integer\n", flag); exit(2); }
    return v;
}
static double need_double(const char *flag, const char *val) {
    char *end;
    double v = strtod(val, &end);
    if (*end != '\0') { fprintf(stderr, "error: %s expects a number\n", flag); exit(2); }
    return v;
}

static int match(const char *arg, const char *shrt, const char *lng) {
    return strcmp(arg, shrt) == 0 || strcmp(arg, lng) == 0;
}

static void parse_args(int argc, char **argv, Config *cfg) {
    for (int i = 1; i < argc; ++i) {
        char *a = argv[i];
        int has_next = (i + 1 < argc);
        const char *nv = has_next ? argv[i + 1] : NULL;

        if (match(a, "-h", "--help")) { usage(argv[0]); exit(0); }

        else if (match(a, "-n", "--particles") && has_next) { cfg->n_particles = (int)need_long(a, nv); i++; }
        else if (match(a, "-W", "--width")      && has_next) { cfg->grid_w      = (int)need_long(a, nv); i++; }
        else if (match(a, "-H", "--height")     && has_next) { cfg->grid_h      = (int)need_long(a, nv); i++; }
        else if (match(a, "-g", "--gravity")    && has_next) { cfg->gravity     = need_double(a, nv);    i++; }
        else if (match(a, "-e", "--restitution")&& has_next) { cfg->restitution = need_double(a, nv);    i++; }
        else if (match(a, "-r", "--radius")     && has_next) { cfg->radius      = need_double(a, nv);    i++; }
        else if (match(a, "-f", "--fps")        && has_next) { cfg->fps         = (int)need_long(a, nv); i++; }
        else if (strcmp(a, "--frames") == 0     && has_next) { cfg->max_frames  = need_long(a, nv);      i++; }
        else if (match(a, "-s", "--seed")       && has_next) { cfg->seed        = (unsigned)need_long(a, nv); i++; }

        else {
            fprintf(stderr, "error: unknown or incomplete option '%s'\n", a);
            fprintf(stderr, "try '%s --help'\n", argv[0]);
            exit(2);
        }
    }
}

static void validate(Config *cfg) {
    if (cfg->n_particles < 1)   cfg->n_particles = 1;
    if (cfg->grid_w < 10)       cfg->grid_w = 10;
    if (cfg->grid_h < 5)        cfg->grid_h = 5;
    if (cfg->fps < 1)           cfg->fps = 1;
    if (cfg->fps > 120)         cfg->fps = 120;
    cfg->restitution = clampd(cfg->restitution, 0.0, 1.0);
    if (cfg->radius <= 0.0)     cfg->radius = 0.1;
    if (cfg->max_frames < 0)    cfg->max_frames = 0;
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

int main(int argc, char **argv) {
    Config cfg = {
        .n_particles = 200,
        .grid_w      = 70,
        .grid_h      = 30,
        .gravity     = 9.8,
        .restitution = 0.85,
        .radius      = 0.6,
        .dt          = 1.0 / 60.0,
        .fps         = 30,
        .max_frames  = 0,
        .seed        = (unsigned)time(NULL),
    };

    parse_args(argc, argv, &cfg);
    validate(&cfg);
    srand(cfg.seed);

    /* Map the character grid to world units. Terminal cells are roughly
     * twice as tall as wide, so we stretch the world height to keep the
     * simulation from looking squashed. */
    g_world_w = (double)cfg.grid_w;
    g_world_h = (double)cfg.grid_h * 2.0;

    Particle *p = malloc((size_t)cfg.n_particles * sizeof(Particle));
    int *counts = malloc((size_t)cfg.grid_w * cfg.grid_h * sizeof(int));

    /* Frame buffer: (w+3) per row (borders + newline) * (h+2) rows + NUL. */
    size_t buf_size = (size_t)(cfg.grid_w + 3) * (cfg.grid_h + 2) + 1;
    char *buf = malloc(buf_size);

    if (!p || !counts || !buf) {
        fprintf(stderr, "error: out of memory\n");
        free(p); free(counts); free(buf);
        return 1;
    }

    /* Seed particles in the upper region with a small random velocity so
     * they fall and splash. Previous position encodes initial velocity. */
    for (int i = 0; i < cfg.n_particles; ++i) {
        double x = frand(cfg.radius, g_world_w - cfg.radius);
        double y = frand(cfg.radius, g_world_h * 0.5);
        double vx = frand(-0.3, 0.3);
        double vy = frand(-0.1, 0.1);
        p[i].x = x;  p[i].y = y;
        p[i].px = x - vx;  p[i].py = y - vy;
    }

    signal(SIGINT, on_sigint);

    /* Hide cursor, clear screen. */
    printf("\033[?25l\033[2J");

    /* Run several physics substeps per rendered frame for stability, then
     * draw once. This decouples physics accuracy from render rate. */
    const int substeps = 4;
    const long nsec_per_frame = 1000000000L / cfg.fps;
    struct timespec sleep_ts = {
        .tv_sec  = nsec_per_frame / 1000000000L,
        .tv_nsec = nsec_per_frame % 1000000000L,
    };
    long frame = 0;

    while (g_running) {
        for (int s = 0; s < substeps; ++s) {
            integrate(p, cfg.n_particles, &cfg);
            solve_collisions(p, cfg.n_particles, &cfg);
            solve_walls(p, cfg.n_particles, &cfg);
        }

        render(p, cfg.n_particles, &cfg, buf, counts);

        /* Move cursor home and paint the frame plus a status line. */
        printf("\033[H%s", buf);
        printf("particles=%d  gravity=%.1f  restitution=%.2f  frame=%ld   \n",
               cfg.n_particles, cfg.gravity, cfg.restitution, frame);
        fflush(stdout);

        frame++;
        if (cfg.max_frames && frame >= cfg.max_frames) break;

        nanosleep(&sleep_ts, NULL);
    }

    /* Restore cursor and leave the terminal tidy. */
    printf("\033[?25h\n");
    fflush(stdout);

    free(p);
    free(counts);
    free(buf);
    return 0;
}
