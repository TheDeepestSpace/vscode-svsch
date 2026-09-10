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
    extractor.clock_signal_names = {"clk", "clock"};
    extractor.reset_signal_names = {"rst", "reset"};
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

    // collapseAliasCombNodes removes the [alias] comb wire-rename nodes and
    // creates direct bus-tap → module-output-port edges instead.
    bool found_bus_node = false;
    bool found_edge_bus_to_a = false;
    bool found_edge_bus_to_b = false;

    for (const auto& node : (*bus_breakout)["nodes"]) {
        if (node["id"] == "bus:bus_breakout:bus_in") {
            found_bus_node = true;
            EXPECT_EQ(node["kind"], "bus");
            bool has_tap0 = false, has_tap1 = false, has_input = false;
            for (const auto& port : node["ports"]) {
                if (port["name"] == "[0]" && port["direction"] == "output") has_tap0 = true;
                if (port["name"] == "[1]" && port["direction"] == "output") has_tap1 = true;
                if (port["name"] == "bus_in" && port["direction"] == "input") has_input = true;
            }
            EXPECT_TRUE(has_tap0);
            EXPECT_TRUE(has_tap1);
            EXPECT_TRUE(has_input);
        }
        // Alias combs are collapsed; they should NOT appear as nodes.
        EXPECT_NE(node["id"], "comb:bus_breakout:a:alias");
        EXPECT_NE(node["id"], "comb:bus_breakout:b:alias");
    }

    for (const auto& edge : (*bus_breakout)["edges"]) {
        // After alias collapse: bus taps wire directly to module output ports.
        if (edge["source"] == "bus:bus_breakout:bus_in" && edge["target"] == "self" &&
            edge["sourcePort"] == "[0]" && edge["targetPort"] == "a") {
            found_edge_bus_to_a = true;
        }
        if (edge["source"] == "bus:bus_breakout:bus_in" && edge["target"] == "self" &&
            edge["sourcePort"] == "[1]" && edge["targetPort"] == "b") {
            found_edge_bus_to_b = true;
        }
    }

    EXPECT_TRUE(found_bus_node);
    EXPECT_TRUE(found_edge_bus_to_a);
    EXPECT_TRUE(found_edge_bus_to_b);
}

TEST(ExtractorTest, ClockSignalNamesDisambiguatesReorderedAsyncSensitivityList) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_async_reorder_dir/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/async_reset_clock_reordered.sv";

        if (std::system("surelog --version > /dev/null 2>&1") != 0) {
            GTEST_SKIP() << "Surelog not available";
        }

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_async_reorder_dir";
        int ret = std::system(command.c_str());
        ASSERT_EQ(ret, 0) << "Surelog failed to parse fixture";
        ASSERT_TRUE(fs::exists(uhdm_path)) << "Surelog did not produce the expected UHDM output";
    }

    UHDM::Serializer serializer;
    std::vector<vpiHandle> restoredDesigns = serializer.Restore(uhdm_path.string());
    ASSERT_FALSE(restoredDesigns.empty());

    vpiHandle design = restoredDesigns[0];
    svsch::DesignExtractor extractor(design);
    extractor.clock_signal_names = {"tck"};
    extractor.reset_signal_names = {"clr"};
    nlohmann::json result = extractor.extract();

    ASSERT_TRUE(result.contains("modules"));

    const nlohmann::json* mod = nullptr;
    for (const auto& m : result["modules"]) {
        if (m["name"] == "async_reset_clock_reordered") {
            mod = &m;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    const nlohmann::json* reg = nullptr;
    for (const auto& node : (*mod)["nodes"]) {
        if (node["kind"] == "register") {
            reg = &node;
            break;
        }
    }
    ASSERT_NE(reg, nullptr) << mod->dump(2);

    // "clr_n" is listed first in the sensitivity list, but only "tck" matches
    // the configured clock_signal_names -- without honoring that config the
    // extractor would (wrongly) pick "clr_n" as the clock via positional
    // fallback. "clr_n" is also not a default reset name, so this only
    // matches because reset_signal_names is configured to {"clr"}.
    EXPECT_EQ((*reg)["metadata"]["clockSignal"], "tck");
    EXPECT_EQ((*reg)["metadata"]["resetSignal"], "clr_n");
    EXPECT_EQ((*reg)["metadata"]["resetActiveLow"], true);
}

TEST(ExtractorTest, SyncResetNestedNegationIsActiveLow) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_sync_reset_nested_negation_dir/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/sync_reset_nested_negation.sv";

        if (std::system("surelog --version > /dev/null 2>&1") != 0) {
            GTEST_SKIP() << "Surelog not available";
        }

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_sync_reset_nested_negation_dir";
        int ret = std::system(command.c_str());
        ASSERT_EQ(ret, 0) << "Surelog failed to parse fixture";
        ASSERT_TRUE(fs::exists(uhdm_path)) << "Surelog did not produce the expected UHDM output";
    }

    UHDM::Serializer serializer;
    std::vector<vpiHandle> restoredDesigns = serializer.Restore(uhdm_path.string());
    ASSERT_FALSE(restoredDesigns.empty());

    vpiHandle design = restoredDesigns[0];
    svsch::DesignExtractor extractor(design);
    extractor.clock_signal_names = {"clk", "clock"};
    extractor.reset_signal_names = {"clr"};
    nlohmann::json result = extractor.extract();

    ASSERT_TRUE(result.contains("modules"));

    const nlohmann::json* mod = nullptr;
    for (const auto& m : result["modules"]) {
        if (m["name"] == "sync_reset_nested_negation") {
            mod = &m;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    const nlohmann::json* reg = nullptr;
    for (const auto& node : (*mod)["nodes"]) {
        if (node["kind"] == "register") {
            reg = &node;
            break;
        }
    }
    ASSERT_NE(reg, nullptr) << mod->dump(2);

    // The reset condition is `enable && !custom_clr_n`: the configured reset
    // identifier is nested under a && operator rather than being the
    // condition's outer operator, so active-low detection must inspect the
    // subtree around the matched identifier, not just the outer op.
    EXPECT_EQ((*reg)["metadata"]["resetSignal"], "custom_clr_n");
    EXPECT_EQ((*reg)["metadata"]["resetActiveLow"], true);
}

TEST(ExtractorTest, SyncResetDoesNotFalsePositiveWhenNoConfiguredNameMatches) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_sync_reset_unconfigured_dir/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/sync_reset_unconfigured_name.sv";

        if (std::system("surelog --version > /dev/null 2>&1") != 0) {
            GTEST_SKIP() << "Surelog not available";
        }

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_sync_reset_unconfigured_dir";
        int ret = std::system(command.c_str());
        ASSERT_EQ(ret, 0) << "Surelog failed to parse fixture";
        ASSERT_TRUE(fs::exists(uhdm_path)) << "Surelog did not produce the expected UHDM output";
    }

    UHDM::Serializer serializer;
    std::vector<vpiHandle> restoredDesigns = serializer.Restore(uhdm_path.string());
    ASSERT_FALSE(restoredDesigns.empty());

    vpiHandle design = restoredDesigns[0];
    svsch::DesignExtractor extractor(design);
    // No configured name can match "clr_n" (e.g. an empty resetSignalNames
    // config). Unlike clock/reset disambiguation in an async sensitivity list
    // (where every identifier present is necessarily a clock or reset signal),
    // an if/else condition can be an arbitrary boolean, so falling back
    // positionally here would misclassify ordinary conditional register
    // updates (e.g. a plain mux select) as synchronous resets. The extractor
    // must not detect a sync reset in this case.
    extractor.reset_signal_names = {};
    nlohmann::json result = extractor.extract();

    ASSERT_TRUE(result.contains("modules"));

    const nlohmann::json* mod = nullptr;
    for (const auto& m : result["modules"]) {
        if (m["name"] == "sync_reset_unconfigured_name") {
            mod = &m;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    const nlohmann::json* reg = nullptr;
    for (const auto& node : (*mod)["nodes"]) {
        if (node["kind"] == "register") {
            reg = &node;
            break;
        }
    }
    ASSERT_NE(reg, nullptr) << mod->dump(2);

    EXPECT_FALSE((*reg)["metadata"].contains("resetKind"));
}

// A compound async sensitivity list (three or more signals) has no guarantee that
// exactly one is a clock and one is a reset -- unlike a two-signal list, which by
// SystemVerilog convention can only be a clock paired with a reset. Positionally
// picking two of the three would silently misclassify (and first-open auto-cut) an
// unrelated net. When none of the signals match a configured clock/reset name, none
// should be tagged as control metadata, but every signal must still surface as a
// register port.
TEST(ExtractorTest, AsyncCompoundEventUnmatchedNamesAreNotControlSignals) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_compound_event_dir/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/compound_event_unmatched.sv";

        if (std::system("surelog --version > /dev/null 2>&1") != 0) {
            GTEST_SKIP() << "Surelog not available";
        }

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_compound_event_dir";
        int ret = std::system(command.c_str());
        ASSERT_EQ(ret, 0) << "Surelog failed to parse fixture";
        ASSERT_TRUE(fs::exists(uhdm_path)) << "Surelog did not produce the expected UHDM output";
    }

    UHDM::Serializer serializer;
    std::vector<vpiHandle> restoredDesigns = serializer.Restore(uhdm_path.string());
    ASSERT_FALSE(restoredDesigns.empty());

    vpiHandle design = restoredDesigns[0];
    svsch::DesignExtractor extractor(design);
    nlohmann::json result = extractor.extract();

    ASSERT_TRUE(result.contains("modules"));

    const nlohmann::json* mod = nullptr;
    for (const auto& m : result["modules"]) {
        if (m["name"] == "compound_event_unmatched") {
            mod = &m;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    const nlohmann::json* reg = nullptr;
    for (const auto& node : (*mod)["nodes"]) {
        if (node["kind"] == "register") {
            reg = &node;
            break;
        }
    }
    ASSERT_NE(reg, nullptr) << mod->dump(2);

    EXPECT_FALSE((*reg)["metadata"].contains("clockSignal"));
    EXPECT_FALSE((*reg)["metadata"].contains("resetSignal"));
    EXPECT_FALSE((*reg)["metadata"].contains("resetKind"));

    std::set<std::string> portNames;
    for (const auto& port : (*reg)["ports"]) portNames.insert(port["name"].get<std::string>());
    EXPECT_TRUE(portNames.count("a")) << reg->dump(2);
    EXPECT_TRUE(portNames.count("b")) << reg->dump(2);
    EXPECT_TRUE(portNames.count("c")) << reg->dump(2);
}

// A boundary `inout` port that is itself an unpacked array (e.g. `inout wire
// [7:0] a [0:1]`) is a hub: per-element muxes drive it on one side, and
// `assign y = a;` reads the whole array back out on the other. Before the
// fix, the array-composition node that combines the per-element drives into
// the whole-array value ALSO paired directly with `y` (via the whole-array
// alias mechanism), producing a second edge that overlapped the one
// correctly routed through the boundary port.
TEST(ExtractorTest, InoutArrayAliasProducesSingleEdgeIntoReader) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_uhdm_dir_inout_array_alias/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/inout_array_alias.sv";

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_uhdm_dir_inout_array_alias";
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
    extractor.clock_signal_names = {"clk", "clock"};
    extractor.reset_signal_names = {"rst", "reset"};
    nlohmann::json result = extractor.extract();

    ASSERT_TRUE(result.contains("modules"));

    const nlohmann::json* mod = nullptr;
    for (const auto& candidate : result["modules"]) {
        if (candidate["name"] == "inout_array_alias") {
            mod = &candidate;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    int edges_into_y = 0;
    bool found_hub_to_y = false;
    bool found_bus_comp_to_y = false;
    for (const auto& edge : (*mod)["edges"]) {
        if (edge["target"] != "self" || edge["targetPort"] != "y") continue;
        edges_into_y += 1;
        if (edge["source"] == "self" && edge["sourcePort"] == "a") found_hub_to_y = true;
        if (edge["source"] == "bus_comp:inout_array_alias:a") found_bus_comp_to_y = true;
    }

    EXPECT_EQ(edges_into_y, 1) << result.dump(2);
    EXPECT_TRUE(found_hub_to_y);
    EXPECT_FALSE(found_bus_comp_to_y);
}

// The hub edge feeding an array-breakout node from a boundary port (e.g.
// `logic [7:0] arr [0:3]` into its breakout node) carries N distinct array
// elements bundled onto one wire, regardless of whether each element is
// itself a scalar or multi-bit net -- it must stay stacked either way.
TEST(ExtractorTest, MultiBitArrayBreakoutHubEdgeStaysStacked) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_uhdm_dir_array_stack_breakout/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/array_stack_breakout.sv";

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_uhdm_dir_array_stack_breakout";
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

    const nlohmann::json* mod = nullptr;
    for (const auto& candidate : result["modules"]) {
        if (candidate["name"] == "array_stack_breakout") {
            mod = &candidate;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    const nlohmann::json* hub_edge = nullptr;
    for (const auto& edge : (*mod)["edges"]) {
        if (edge["source"] == "self" && edge["sourcePort"] == "arr" &&
            edge["targetPort"] == "arr") {
            hub_edge = &edge;
            break;
        }
    }
    ASSERT_NE(hub_edge, nullptr) << result.dump(2);
    EXPECT_EQ((*hub_edge)["width"], "[7:0]");
    ASSERT_TRUE(hub_edge->contains("isStacked")) << result.dump(2);
    EXPECT_TRUE((*hub_edge)["isStacked"]);
}

// A breakout tap whose own net is multi-bit (e.g. `inout wire [7:0] a
// [0:1]`, tapped as `a[0]`) is one wide wire per element, not a bundle of
// scalar lanes. This is most visible when the tap feeds another
// array-capable node (here, one of the per-element tristate muxes selected
// by `drive_enable[i]`): before the fix, every tap out of a breakout node
// was marked stacked whenever it fed an array-capable consumer, regardless
// of the element width, so it rendered as a converging stacked fan instead
// of a single thick wire.
TEST(ExtractorTest, MultiBitArrayBreakoutTapIntoMuxIsNotStacked) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_uhdm_dir_inout_array_alias/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/inout_array_alias.sv";

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_uhdm_dir_inout_array_alias";
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

    const nlohmann::json* mod = nullptr;
    for (const auto& candidate : result["modules"]) {
        if (candidate["name"] == "inout_array_alias") {
            mod = &candidate;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    int tap_edges_found = 0;
    for (const auto& edge : (*mod)["edges"]) {
        if (edge["source"] != "bus:inout_array_alias:drive_enable") continue;
        tap_edges_found += 1;
        EXPECT_FALSE(edge.contains("isStacked") && edge["isStacked"] == true) << edge.dump(2);
    }
    EXPECT_EQ(tap_edges_found, 2) << result.dump(2);

    // The hub edge feeding the breakout node stays stacked regardless.
    const nlohmann::json* hub_edge = nullptr;
    for (const auto& edge : (*mod)["edges"]) {
        if (edge["source"] == "self" && edge["sourcePort"] == "drive_enable" &&
            edge["target"] == "bus:inout_array_alias:drive_enable") {
            hub_edge = &edge;
            break;
        }
    }
    ASSERT_NE(hub_edge, nullptr) << result.dump(2);
    ASSERT_TRUE(hub_edge->contains("isStacked")) << result.dump(2);
    EXPECT_TRUE((*hub_edge)["isStacked"]);
}

// A breakout node whose *elements* are themselves scalar (e.g. `logic y_arr
// [3:0]`, an array of single-bit nets fed by an instance array's per-element
// outputs) still has taps that are already-resolved individual signals, not
// a bundle -- `y_arr[0]` names exactly one net. Before this fix, every
// breakout node's output ports (its per-element taps) were unconditionally
// added to the backend's "stacked signals" set just because the node itself
// was array-flagged, so these taps rendered as a converging stacked fan
// (three parallel lines) even though each is a single 1-bit wire. Only the
// hub edge feeding the breakout node from the instance array (which
// genuinely bundles N distinct 1-bit signals onto one wire) should stay
// stacked.
TEST(ExtractorTest, SingleBitArrayBreakoutTapsAreNotStacked) {
    namespace fs = std::filesystem;

    const fs::path uhdm_path = fs::path("test_uhdm_dir_instance_array/slpp_all/surelog.uhdm");
    if (!fs::exists(uhdm_path)) {
        const fs::path fixture_path = fs::path(__FILE__)
            .parent_path().parent_path().parent_path().parent_path().parent_path()
            / "test/fixtures/instance_array.sv";

        const std::string command = "surelog -parse -sverilog " + fixture_path.string() + " -o test_uhdm_dir_instance_array";
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

    const nlohmann::json* mod = nullptr;
    for (const auto& candidate : result["modules"]) {
        if (candidate["name"] == "instance_array_top") {
            mod = &candidate;
            break;
        }
    }
    ASSERT_NE(mod, nullptr) << result.dump(2);

    int tap_edges_found = 0;
    for (const auto& edge : (*mod)["edges"]) {
        if (edge["source"] != "bus:instance_array_top:y_arr") continue;
        tap_edges_found += 1;
        EXPECT_FALSE(edge.contains("isStacked") && edge["isStacked"] == true) << edge.dump(2);
    }
    EXPECT_EQ(tap_edges_found, 4) << result.dump(2);

    // The hub edge feeding the breakout node from the mux instance array
    // still bundles 4 distinct 1-bit signals onto one wire and must stay stacked.
    const nlohmann::json* hub_edge = nullptr;
    for (const auto& edge : (*mod)["edges"]) {
        if (edge["target"] == "bus:instance_array_top:y_arr") {
            hub_edge = &edge;
            break;
        }
    }
    ASSERT_NE(hub_edge, nullptr) << result.dump(2);
    ASSERT_TRUE(hub_edge->contains("isStacked")) << result.dump(2);
    EXPECT_TRUE((*hub_edge)["isStacked"]);
}

int main(int argc, char **argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}

