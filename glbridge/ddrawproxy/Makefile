# Makefile — Build ddraw.dll for Windows 9x (MinGW cross-compile)
#
# Requirements:
#   apt: mingw-w64 (or brew: mingw-w64)
#   The output is a native Windows DLL that goes into the emulated
#   Windows guest's system directory (e.g. C:\WINDOWS\SYSTEM\ddraw.dll)
#
# To build:
#   make             → ddraw/ddraw.dll
#   make clean       → remove build artifacts

CROSS   ?= i686-w64-mingw32
CC       = $(CROSS)-gcc
WINDRES  = $(CROSS)-windres
STRIP    = $(CROSS)-strip

CFLAGS  := -Os -std=c99 -Wall -Wextra \
           -fomit-frame-pointer \
           -I$(CURDIR)/include \
           -DWIN32_LEAN_AND_MEAN \
           -D_WIN32_WINNT=0x0400 \
           -mcpu=pentium \
           -mpreferred-stack-boundary=2

LDFLAGS := -shared -Wl,--enable-stdcall-fixup \
           -Wl,--kill-at \
           -Wl,--out-implib,ddraw/ddraw.lib \
           -static-libgcc

OBJS    = ddraw/ddraw.o ddraw/d3d7.o ddraw/bridge.o

.PHONY: all clean

all: ddraw/ddraw.dll

ddraw/ddraw.dll: $(OBJS) ddraw/ddraw.def
	$(CC) $(CFLAGS) $(OBJS) $(LDFLAGS) \
		-o $@ \
		-Wl,-Map,ddraw/ddraw.map \
		-L ddraw/ddraw.def
	$(STRIP) --strip-all $@
	@echo "=== Built: $@ ==="
	@ls -lh $@

ddraw/%.o: ddraw/%.c include/ddraw_bridge.h
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f ddraw/*.o ddraw/*.dll ddraw/*.lib ddraw/*.map