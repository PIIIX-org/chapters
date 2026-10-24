require 'json'
require_relative 'codec'
require_relative '../lib/index.rb'

MAX_ITEMS = 1024

module Elara
  module Storage
    VERSION = '1.0'

    def self.open(root)
      Store.new(root)
    end

    class Store < Base
      attr_reader :root

      def initialize(root)
        @root = root
      end

      def load(key)
        decode = ->(raw) { raw }
        decode.call(key)
      end

      def self.default
        new('.')
      end

      class << self
        def instances
          0
        end
      end

      private

      def helper; end
    end
  end

  def mixin_method
    true
  end
end

def top_level(x)
  def inner; end
  x
end
