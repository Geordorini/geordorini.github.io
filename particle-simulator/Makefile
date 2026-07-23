# Makefile for the terminal particle simulator.

CC      ?= cc
CFLAGS  ?= -std=c99 -O2 -Wall -Wextra -Wpedantic
LDLIBS  := -lm
TARGET  := particle_sim
SRC     := particle_sim.c

.PHONY: all run clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

# Quick demo run.
run: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(TARGET)
