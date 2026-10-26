#ifndef STORE_H
#define STORE_H

#include <stddef.h>
#include "codec.h"

#define MAX_ITEMS 1024

typedef struct {
    size_t len;
} Buffer;

struct store {
    char *root;
    int count;
};

enum event { EVENT_PUT, EVENT_DELETE };

struct store *store_open(const char *root);
int store_count(const struct store *s);

#endif
