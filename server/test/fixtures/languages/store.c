#include <stdlib.h>
#include "store.h"
#include "../util/log.h"

static int helper(int x);

struct store *store_open(const char *root) {
    struct store *s = malloc(sizeof *s);
    s->root = (char *)root;
    s->count = helper(0);
    return s;
}

int store_count(const struct store *s) {
    return s->count;
}

static int helper(int x) {
    return x + 1;
}
