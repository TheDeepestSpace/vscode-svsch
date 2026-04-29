#include <iostream>
#include <string>
#include <vector>
#include <uhdm/uhdm.h>
#include <uhdm/Serializer.h>
#include "json.hpp"
#include "extractor.hpp"

using json = nlohmann::json;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <uhdm_file>" << std::endl;
        return 1;
    }

    std::string filename = argv[1];
    UHDM::Serializer serializer;
    std::vector<vpiHandle> designs = serializer.Restore(filename);

    if (designs.empty()) {
        std::cerr << "Failed to restore UHDM design from " << filename << std::endl;
        return 1;
    }

    svsch::DesignExtractor extractor(designs[0]);
    json output = extractor.extract();

    std::cout << output.dump(2) << std::endl;

    return 0;
}
