DesignExtractor::DesignExtractor(vpiHandle design) : design_(design) {}

std::string sanitizeId(const std::string& id) {
    std::string result = id;
    for (char &c : result) {
        unsigned char value = static_cast<unsigned char>(c);
        if (!std::isalnum(value) && c != '_' && c != '$' && c != '.' && c != '-' && c != ':') {
            c = '_';
        }
    }
    return result;
}

bool looksNamedLiteral(const std::string& label) {
    if (label.empty()) return false;
    unsigned char first = static_cast<unsigned char>(label[0]);
    return std::isalpha(first) || label[0] == '_' || label[0] == '$';
}

std::string trimCopy(const std::string& value) {
    size_t start = 0;
    while (start < value.size() && std::isspace(static_cast<unsigned char>(value[start]))) start++;
    size_t end = value.size();
    while (end > start && std::isspace(static_cast<unsigned char>(value[end - 1]))) end--;
    return value.substr(start, end - start);
}

// Evaluate the small constant-expression subset used by unpacked array bounds.
// Surelog does not consistently expose parameterized unpacked ranges through VPI,
// so source declarations such as [0:(1 << ADDR_WIDTH)-1] need a deterministic
// fallback once module parameter values have been collected.
std::optional<int> evaluateConstantExpression(
    const std::string& text,
    const std::map<std::string, int>& parameters
) {
    size_t pos = 0;
    auto skip_space = [&]() {
        while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) pos++;
    };

    std::function<std::optional<int>()> parse_shift;
    std::function<std::optional<int>()> parse_additive;
    std::function<std::optional<int>()> parse_multiplicative;
    std::function<std::optional<int>()> parse_primary;

    parse_primary = [&]() -> std::optional<int> {
        skip_space();
        if (pos >= text.size()) return std::nullopt;

        if (text[pos] == '(') {
            pos++;
            auto value = parse_shift();
            skip_space();
            if (!value || pos >= text.size() || text[pos] != ')') return std::nullopt;
            pos++;
            return value;
        }

        if (text[pos] == '+' || text[pos] == '-') {
            char sign = text[pos++];
            auto value = parse_primary();
            if (!value) return std::nullopt;
            return sign == '-' ? -*value : *value;
        }

        size_t start = pos;
        if (std::isdigit(static_cast<unsigned char>(text[pos]))) {
            while (pos < text.size() && std::isdigit(static_cast<unsigned char>(text[pos]))) pos++;
            try {
                return std::stoi(text.substr(start, pos - start));
            } catch (...) {
                return std::nullopt;
            }
        }

        if (std::isalpha(static_cast<unsigned char>(text[pos])) || text[pos] == '_' || text[pos] == '$') {
            while (pos < text.size()) {
                unsigned char ch = static_cast<unsigned char>(text[pos]);
                if (!std::isalnum(ch) && text[pos] != '_' && text[pos] != '$') break;
                pos++;
            }
            auto parameter = parameters.find(text.substr(start, pos - start));
            return parameter == parameters.end()
                ? std::nullopt
                : std::optional<int>(parameter->second);
        }

        return std::nullopt;
    };

    parse_multiplicative = [&]() -> std::optional<int> {
        auto left = parse_primary();
        while (left) {
            skip_space();
            if (pos >= text.size() || (text[pos] != '*' && text[pos] != '/' && text[pos] != '%')) break;
            char op = text[pos++];
            auto right = parse_primary();
            if (!right || ((op == '/' || op == '%') && *right == 0)) return std::nullopt;
            if (op == '*') left = *left * *right;
            else if (op == '/') left = *left / *right;
            else left = *left % *right;
        }
        return left;
    };

    parse_additive = [&]() -> std::optional<int> {
        auto left = parse_multiplicative();
        while (left) {
            skip_space();
            if (pos >= text.size() || (text[pos] != '+' && text[pos] != '-')) break;
            char op = text[pos++];
            auto right = parse_multiplicative();
            if (!right) return std::nullopt;
            left = op == '+' ? *left + *right : *left - *right;
        }
        return left;
    };

    parse_shift = [&]() -> std::optional<int> {
        auto left = parse_additive();
        while (left) {
            skip_space();
            bool shift_left = text.compare(pos, 2, "<<") == 0;
            bool shift_right = text.compare(pos, 2, ">>") == 0;
            if (!shift_left && !shift_right) break;
            pos += 2;
            auto right = parse_additive();
            if (!right || *right < 0 || *right >= static_cast<int>(sizeof(int) * 8)) {
                return std::nullopt;
            }
            left = shift_left ? *left << *right : *left >> *right;
        }
        return left;
    };

    auto result = parse_shift();
    skip_space();
    return result && pos == text.size() ? result : std::nullopt;
}

bool declarationListContains(const std::string& declarations, const std::string& name) {
    std::stringstream stream(declarations);
    std::string item;
    while (std::getline(stream, item, ',')) {
        item = trimCopy(item);
        size_t equals = item.find('=');
        if (equals != std::string::npos) item = trimCopy(item.substr(0, equals));
        size_t bracket = item.find('[');
        if (bracket != std::string::npos) item = trimCopy(item.substr(0, bracket));
        if (item == name) return true;
    }
    return false;
}

bool matchesSignalNameList(const std::string& name, const std::vector<std::string>& candidates) {
    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return std::tolower(c); });
    for (const std::string& candidate : candidates) {
        if (candidate.empty()) continue;
        std::string lowerCandidate = candidate;
        std::transform(lowerCandidate.begin(), lowerCandidate.end(), lowerCandidate.begin(), [](unsigned char c) { return std::tolower(c); });
        if (lower.find(lowerCandidate) != std::string::npos) return true;
    }
    return false;
}

bool looksResetSignal(const std::string& name, const std::vector<std::string>& reset_signal_names) {
    return matchesSignalNameList(name, reset_signal_names);
}

bool looksClockSignal(const std::string& name, const std::vector<std::string>& clock_signal_names) {
    return matchesSignalNameList(name, clock_signal_names);
}

std::string constantIntString(vpiHandle handle) {
    if (!handle) return "";
    s_vpi_value value;
    value.format = vpiDecStrVal;
    vpi_get_value(handle, &value);
    if (value.format != vpiSuppressVal && value.value.str) {
        return value.value.str;
    }
    return "";
}

std::string constantIntString(const UHDM::expr* expr) {
    if (!expr) return "";
    std::string value(expr->VpiValue());
    if (value.empty()) value = std::string(expr->VpiDecompile());
    size_t colon = value.find_last_of(':');
    if (colon != std::string::npos && colon + 1 < value.size()) {
        value = value.substr(colon + 1);
    }
    return trimCopy(value);
}

std::string explicitTypespecRange(vpiHandle handle) {
    if (!handle || vpi_get(vpiType, handle) != vpiLogicTypespec) return "";

    auto* wrapped = reinterpret_cast<uhdm_handle*>(handle);
    if (wrapped && wrapped->type == UHDM::UHDM_OBJECT_TYPE::uhdmlogic_typespec && wrapped->object) {
        auto* logic = static_cast<const UHDM::logic_typespec*>(wrapped->object);
        if (logic->Ranges() && !logic->Ranges()->empty()) {
            const UHDM::range* range = logic->Ranges()->front();
            std::string left = constantIntString(range ? range->Left_expr() : nullptr);
            std::string right = constantIntString(range ? range->Right_expr() : nullptr);
            if (!left.empty() && !right.empty() && (left != "0" || right != "0")) {
                return "[" + left + ":" + right + "]";
            }
        }

        std::string left = constantIntString(logic->Left_expr());
        std::string right = constantIntString(logic->Right_expr());
        if (!left.empty() && !right.empty() && (left != "0" || right != "0")) {
            return "[" + left + ":" + right + "]";
        }
    }

    int left = vpi_get(vpiLeftRange, handle);
    int right = vpi_get(vpiRightRange, handle);
    if (left != vpiUndefined && right != vpiUndefined && (left != 0 || right != 0)) {
        return "[" + std::to_string(left) + ":" + std::to_string(right) + "]";
    }
    return "";
}

// True when a declared range can span more than one bit: a numeric range like
// "[7:0]", or a symbolic range like "[X:0]" whose parameter may still exceed
// zero at elaboration time. A constant single-bit range ("[0:0]", "[3:3]")
// stays false. Mirrors widthIsPotentiallyMultiBit in src/ir/edgeStyle.ts so
// the backend's stacked-vs-thick classification agrees with the frontend's.
bool widthIsPotentiallyMultiBit(const std::string& width) {
    if (width.empty() || width == "interface") return false;
    static const std::regex rangeRe(R"(^\s*\[\s*([^:\[\]]+?)\s*:\s*([^:\[\]]+?)\s*\]\s*$)");
    std::smatch m;
    if (!std::regex_match(width, m, rangeRe)) {
        // Multi-dimensional packed ranges (e.g. [7:0][3:0]) are always multi-bit.
        return width.find("][") != std::string::npos;
    }
    try {
        size_t msb_pos, lsb_pos;
        int msb = std::stoi(m[1].str(), &msb_pos);
        int lsb = std::stoi(m[2].str(), &lsb_pos);
        if (msb_pos == m[1].str().size() && lsb_pos == m[2].str().size()) {
            return msb != lsb;
        }
    } catch (...) {
        // Fall through: non-numeric range, treated as potentially multi-bit below.
    }
    return true;
}

int rangeWidthInBits(const std::string& width) {
    if (width.size() < 3 || width.front() != '[' || width.back() != ']') return 1;
    size_t colon = width.find(':');
    if (colon == std::string::npos) return 1;
    try {
        int left = std::stoi(trimCopy(width.substr(1, colon - 1)));
        int right = std::stoi(trimCopy(width.substr(colon + 1, width.size() - colon - 2)));
        return std::abs(left - right) + 1;
    } catch (...) {
        return 1;
    }
}

std::ifstream DesignExtractor::openSourceFile(const std::string& source_file) const {
    if (source_file.empty()) return std::ifstream();
    std::string path = source_file;
    if (path.length() > 0 && path[0] != '/' && !workspace_root.empty()) {
        path = workspace_root + "/" + path;
    }
    return std::ifstream(path);
}
