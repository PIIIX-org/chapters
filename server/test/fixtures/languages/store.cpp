#include <map>
#include <string>
#include "store.hpp"

namespace elara {
namespace detail {

int hash(const std::string& key);

}  // namespace detail

template <typename T>
class Store : public Backend {
public:
    explicit Store(std::string root);
    T load(const std::string& key) const;
    void save(const std::string& key, T value) {
        items_[key] = value;
    }

private:
    struct Node {
        void visit() {}
    };
    std::map<std::string, T> items_;
};

struct Options {
    bool sync = false;
};

enum class Event { Put, Delete };

template <typename T>
T Store<T>::load(const std::string& key) const {
    auto local = [](int x) { return x; };
    return items_.at(key);
}

}  // namespace elara

static void run() {}

int main() {
    run();
    return 0;
}
