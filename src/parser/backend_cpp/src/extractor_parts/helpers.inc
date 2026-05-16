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

bool looksResetSignal(const std::string& name) {
    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return std::tolower(c); });
    return lower.find("rst") != std::string::npos || lower.find("reset") != std::string::npos;
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
