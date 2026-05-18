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
        std::cerr << "Usage: " << argv[0] << " <uhdm_file> [target_module|--list-only]" << std::endl;
        return 1;
    }

    std::string filename = argv[1];
    std::string targetModule = (argc >= 3) ? argv[2] : "";
    bool listOnly = (targetModule == "--list-only");

    UHDM::Serializer serializer;
    std::vector<vpiHandle> designs = serializer.Restore(filename);

    if (designs.empty()) {
        std::cerr << "Failed to restore UHDM design from " << filename << std::endl;
        return 1;
    }

    if (listOnly) {
        vpiHandle design = designs[0];
        json output = json::object();
        output["modules"] = json::array();
        output["rootModules"] = json::array();

        std::set<std::string> all_modules;
        std::set<std::string> instantiated;

        const int uhdmallModules = 2008;
        vpiHandle all_mod_itr = vpi_iterate(uhdmallModules, design);
        if (all_mod_itr) {
            while (vpiHandle mod_handle = vpi_scan(all_mod_itr)) {
                const char* def_name = vpi_get_str(vpiDefName, mod_handle);
                if (def_name) {
                    all_modules.insert(def_name);
                    
                    vpiHandle inst_itr = vpi_iterate(vpiModule, mod_handle);
                    if (inst_itr) {
                        while (vpiHandle inst_handle = vpi_scan(inst_itr)) {
                            const char* inst_def_name = vpi_get_str(vpiDefName, inst_handle);
                            if (inst_def_name) instantiated.insert(inst_def_name);
                        }
                    }
                }
            }
        }

        for (const auto& name : all_modules) {
            json m = json::object();
            m["name"] = name;
            output["modules"].push_back(m);
            if (instantiated.find(name) == instantiated.end()) {
                output["rootModules"].push_back(name);
            }
        }
        std::cout << output.dump(2) << std::endl;
        return 0;
    }

    svsch::DesignExtractor extractor(designs[0]);
    json output = extractor.extract(targetModule);

    std::cout << output.dump(2) << std::endl;

    return 0;
}
