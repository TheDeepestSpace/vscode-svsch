#include <gtest/gtest.h>
#include "extractor.hpp"
#include <uhdm/uhdm.h>
#include <uhdm/Serializer.h>
#include <cstdlib>
#include <fstream>
#include <filesystem>

TEST(ExtractorTest, BasicJsonStructure) {
    nlohmann::json j;
    j["test"] = 1;
    EXPECT_EQ(j["test"], 1);
}

TEST(ExtractorTest, BusBreakoutOutputsExpectedNodes) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_uhdm_dir/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/bus_breakout.sv";

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_uhdm_dir";
        int ret = std::system(command.c_str());
        if (ret != 0 || !fs::exists(uhdm_path)) {
            GTEST_SKIP() << "Surelog not available or failed";
        }
    }

    UHDM::Serializer serializer;
    std::vector<vpiHandle> restoredDesigns = serializer.Restore(uhdm_path.string());
    ASSERT_FALSE(restoredDesigns.empty());

    vpiHandle design = restoredDesigns[0];
    svsch::DesignExtractor extractor(design);
    nlohmann::json result = extractor.extract();

    ASSERT_TRUE(result.contains("modules"));

    const nlohmann::json* bus_breakout = nullptr;
    for (const auto& mod : result["modules"]) {
        if (mod["name"] == "bus_breakout") {
            bus_breakout = &mod;
            break;
        }
    }
    ASSERT_NE(bus_breakout, nullptr) << result.dump(2);

    EXPECT_EQ(result["rootModules"], nlohmann::json::array({"bus_breakout"}));

    bool found_comb_a = false;
    bool found_comb_b = false;
    bool found_edge_a_to_output = false;
    bool found_edge_b_to_output = false;
    bool found_edge_bus_to_a = false;
    bool found_edge_bus_to_b = false;

    for (const auto& node : (*bus_breakout)["nodes"]) {
        if (node["id"] == "comb:bus_breakout:a") {
            found_comb_a = true;
            EXPECT_EQ(node["kind"], "comb");
            EXPECT_EQ(node["metadata"]["expression"], "[alias]");
            bool has_output_a = false;
            bool has_input_bus = false;
            for (const auto& port : node["ports"]) {
                if (port["name"] == "a" && port["direction"] == "output") has_output_a = true;
                if (port["name"] == "bus_in" && port["direction"] == "input") has_input_bus = true;
            }
            EXPECT_TRUE(has_output_a);
            EXPECT_TRUE(has_input_bus);
        }
        if (node["id"] == "comb:bus_breakout:b") {
            found_comb_b = true;
            EXPECT_EQ(node["kind"], "comb");
            EXPECT_EQ(node["metadata"]["expression"], "[alias]");
            bool has_output_b = false;
            bool has_input_bus = false;
            for (const auto& port : node["ports"]) {
                if (port["name"] == "b" && port["direction"] == "output") has_output_b = true;
                if (port["name"] == "bus_in" && port["direction"] == "input") has_input_bus = true;
            }
            EXPECT_TRUE(has_output_b);
            EXPECT_TRUE(has_input_bus);
        }
    }

    for (const auto& edge : (*bus_breakout)["edges"]) {
        if (edge["source"] == "comb:bus_breakout:a" && edge["target"] == "self" &&
            edge["sourcePort"] == "a" && edge["targetPort"] == "a") {
            found_edge_a_to_output = true;
        }
        if (edge["source"] == "comb:bus_breakout:b" && edge["target"] == "self" &&
            edge["sourcePort"] == "b" && edge["targetPort"] == "b") {
            found_edge_b_to_output = true;
        }
        if (edge["source"] == "self" && edge["target"] == "comb:bus_breakout:a" &&
            edge["sourcePort"] == "bus_in" && edge["targetPort"] == "bus_in") {
            found_edge_bus_to_a = true;
        }
        if (edge["source"] == "self" && edge["target"] == "comb:bus_breakout:b" &&
            edge["sourcePort"] == "bus_in" && edge["targetPort"] == "bus_in") {
            found_edge_bus_to_b = true;
        }
    }

    EXPECT_TRUE(found_comb_a);
    EXPECT_TRUE(found_comb_b);
    EXPECT_TRUE(found_edge_a_to_output);
    EXPECT_TRUE(found_edge_b_to_output);
    EXPECT_TRUE(found_edge_bus_to_a);
    EXPECT_TRUE(found_edge_bus_to_b);
}

int main(int argc, char **argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}

