/*
 * guid.c — GUID definitions for the ddraw bridge
 *
 * MinGW's ddraw.h/d3d.h declare the IIDs but don't define them
 * unless INITGUID is defined before include. We define them here
 * in a separate translation unit.
 */

#define INITGUID
#include <windows.h>
#include <ddraw.h>
#include <d3d.h>

#include "ddraw_bridge.h"
#include "ddraw_internal.h"

/* The DEFINE_GUID macro with INITGUID creates the actual definitions */
/* (they are declared extern in ddraw.h without INITGUID) */